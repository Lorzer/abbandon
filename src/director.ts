/**
 * ABBADON - Director abstraction.
 *
 * A Director decides each round's weather and events. Two implementations:
 *  - ScriptedDirector: deterministic, parametric, no network. Same seed+config
 *    => identical weather every run. Used for tuning and tests (useLLM=false).
 *  - GemmaDirector: Gemma 4 narrative via the colla_gemma Supabase edge
 *    function; validates/clamps output and falls back to scripted on failure.
 */

import type { LLMDecision, TriggeredEvent, WorldState, Hexagon } from './types.js';
import type { SimConfig } from './config.js';
import { RNG } from './rng.js';

export interface Director {
  initialize(): Promise<void>;
  getDecision(round: number, state: WorldState): Promise<LLMDecision>;
}

const VALID_EVENT_TYPES: TriggeredEvent['event_type'][] = [
  'violence',
  'disease',
  'infrastructure_collapse',
  'resource_discovery',
];

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Sanitize a (possibly LLM-produced) decision so a single bad generation can't
 * inject extreme values into the simulation. Bounds are deliberately generous
 * but finite.
 */
export function clampDecision(raw: any): LLMDecision {
  const effects = raw?.weather_effects ?? {};
  const events: TriggeredEvent[] = Array.isArray(raw?.triggered_events)
    ? raw.triggered_events
        .filter((e: any) => e && VALID_EVENT_TYPES.includes(e.event_type) && typeof e.hex_id === 'string')
        .map((e: any) => ({
          hex_id: e.hex_id,
          event_type: e.event_type,
          severity: clamp(Number(e.severity), 1, 10),
          reason: typeof e.reason === 'string' ? e.reason : '',
        }))
    : [];

  return {
    weather: typeof raw?.weather === 'string' ? raw.weather : 'unknown',
    weather_severity: clamp(Number(raw?.weather_severity), 1, 10),
    weather_effects: {
      water_impact: clamp(Number(effects.water_impact), -50, 20),
      food_impact: clamp(Number(effects.food_impact), -50, 20),
      infrastructure_impact: clamp(Number(effects.infrastructure_impact), -50, 20),
    },
    triggered_events: events,
    infrastructure_decay_multiplier: clamp(Number(raw?.infrastructure_decay_multiplier), 0.5, 5),
    narrative: typeof raw?.narrative === 'string' ? raw.narrative : '',
  };
}

/**
 * Deterministic weather that worsens over the run. Severity ramps with round
 * (climate collapse), with small seeded jitter so runs aren't perfectly smooth
 * but remain reproducible. Emits weather only (no triggered events) so the
 * conservation invariant stays clean and the pacing is predictable.
 */
export class ScriptedDirector implements Director {
  constructor(private config: SimConfig) {}

  async initialize(): Promise<void> {
    // Nothing to set up; deterministic.
  }

  async getDecision(round: number): Promise<LLMDecision> {
    const { totalRounds } = this.config;
    // Progress 0..1 across the run; severity climbs from ~2 to ~10.
    const progress = clamp(round / totalRounds, 0, 1);
    const rng = new RNG(this.config.seed * 1000 + round);
    const jitter = rng.range(-1, 1);
    const severity = clamp(Math.round(2 + progress * 8 + jitter), 1, 10);

    return clampDecision({
      weather: 'deteriorating',
      weather_severity: severity,
      weather_effects: {
        water_impact: -severity * 1.5,
        food_impact: -severity * 1.0,
        infrastructure_impact: -severity * 0.5,
      },
      triggered_events: [],
      infrastructure_decay_multiplier: 1 + progress * 1.5,
      narrative: `Round ${round}: conditions deteriorating (severity ${severity}/10).`,
    });
  }
}

/** Strip ```json fences / grab the first {...} or [...]; Gemma has no JSON mode. */
export function parseJsonLoose(raw: string): any {
  const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }
  const m = cleaned.match(/[[{][\s\S]*[\]}]/);
  if (m) return JSON.parse(m[0]);
  throw new Error('No JSON found in model output');
}

const SYSTEM_PROMPT = `You are the Climate Crisis Director for ABBADON, a 60-round simulation of societal collapse in the Berlin-Brandenburg-MV region (~1M people, 100 hexagons).

ROLE: Each round (1 month), you decide:
1. Weather conditions (normal, heatwave, drought, storm)
2. Severity of weather effects on water, food, and infrastructure
3. Specific triggered events (violence, disease, infrastructure collapse, resource discovery)
4. Infrastructure decay rate multiplier
5. Narrative summary (2-3 sentences)

PROGRESSION GUIDELINES:
- Rounds 1-10: Stable with minor degradation (severity 2-4)
- Rounds 11-20: Increasing pressure (severity 4-6)
- Rounds 21-40: Major challenges (severity 6-8)
- Rounds 41-60: Harsh conditions (severity 7-10)

TRIGGER RULES:
- Only trigger events when thresholds are met:
  * Violence: When food < 10 tons OR water < 30% in a hex
  * Disease: When population density very high (>5000/km²) OR water < 20%
  * Infrastructure collapse: When infrastructure < 40%
  * Resource discovery: Rarely, to provide hope (max 1-2 per simulation)
- Do NOT trigger events arbitrarily - they must make narrative sense

OUTPUT FORMAT (JSON only, no markdown):
{
  "weather": "heatwave",
  "weather_severity": 7,
  "weather_effects": { "water_impact": -25, "food_impact": -20, "infrastructure_impact": -15 },
  "triggered_events": [
    {"hex_id": "HEX_003", "event_type": "violence", "severity": 8, "reason": "Food shortage critical"}
  ],
  "infrastructure_decay_multiplier": 1.8,
  "narrative": "Brutal heatwave strikes. Power grids failing. Violence erupts in HEX_003 as food runs out."
}

Remember: Build tension gradually. Early rounds should feel manageable. Late rounds should feel desperate. Collapse is the premise - the region WILL decline; you shape the pace and texture.`;

/** Build a compact, stateless state summary for the LLM prompt (no chat history). */
function buildUserPrompt(round: number, state: WorldState): string {
  const hexes = state.hexagons;
  const gs = state.gameState;
  const urban = hexes.filter((h) => h.type === 'urban');
  const rural = hexes.filter((h) => h.type === 'rural');
  const sum = (arr: Hexagon[], f: (h: Hexagon) => number) => arr.reduce((s, h) => s + f(h), 0);

  // The most stressed hexes are the most decision-relevant.
  const critical = [...hexes]
    .sort((a, b) => a.net_force - b.net_force)
    .slice(0, 12)
    .map(
      (h) =>
        `${h.id}[${h.type}]: ${Math.round(h.population)} pop, ${h.food_stored_tons.toFixed(0)}t food, ` +
        `${h.water_availability.toFixed(0)}% water, infra ${(
          (h.infrastructure_power + h.infrastructure_water + h.infrastructure_roads) / 3
        ).toFixed(0)}%, violence ${h.violence_level}, net ${h.net_force.toFixed(0)}`
    )
    .join('\n');

  return `ROUND ${round}/${state.config.totalRounds}

GLOBAL: population ${Math.round(gs.total_population).toLocaleString()} (urban ${Math.round(
    sum(urban, (h) => h.population)
  ).toLocaleString()}, rural ${Math.round(sum(rural, (h) => h.population)).toLocaleString()}), ` +
    `food ${Math.round(gs.total_food_tons)}t, deaths ${gs.total_deaths} (${gs.deaths_starvation} starvation, ${gs.deaths_transit} transit).

MOST STRESSED HEXES (lowest net force):
${critical}

Decide this round's weather and events. Return JSON only.`;
}

/**
 * Gemma 4 director: builds the prompt from WorldState, calls the colla_gemma
 * Supabase edge function (which holds the Gemini keys), validates/clamps the
 * result, and falls back to a scripted decision if anything goes wrong.
 */
export class GemmaDirector implements Director {
  private fallback: ScriptedDirector;

  constructor(private config: SimConfig) {
    this.fallback = new ScriptedDirector(config);
  }

  async initialize(): Promise<void> {
    /* stateless */
  }

  async getDecision(round: number, state: WorldState): Promise<LLMDecision> {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return this.fallback.getDecision(round);

    try {
      const res = await fetch(`${url}/functions/v1/colla_gemma`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: buildUserPrompt(round, state),
          thinkingLevel: this.config.llm.thinkingLevel,
        }),
      });
      if (!res.ok) throw new Error(`colla_gemma ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      if (!data.text) throw new Error('empty Gemma response');
      return clampDecision(parseJsonLoose(data.text));
    } catch (err) {
      console.error('GemmaDirector error, falling back to scripted:', err);
      return this.fallback.getDecision(round);
    }
  }
}
