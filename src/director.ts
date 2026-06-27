/**
 * ABBADON - Director abstraction.
 *
 * A Director decides each round's weather and events. Two implementations:
 *  - ScriptedDirector: deterministic, parametric, no network. Same seed+config
 *    => identical weather every run. Used for tuning and tests (useLLM=false).
 *  - LLMDirector (in llm.ts): Gemini-driven narrative, with output validation.
 */

import type { LLMDecision, TriggeredEvent, WorldState } from './types.js';
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
