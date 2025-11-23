/**
 * ABBADON Phase 1 - LLM Director (Gemini Integration)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type Database from 'better-sqlite3';
import type { LLMDecision, Hexagon, GameState, HexChange } from './types.js';

export class LLMDirector {
  private genAI: GoogleGenerativeAI;
  private chat: any;
  private previousHexagons: Map<string, Hexagon> = new Map();
  private isInitialized: boolean = false;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  /**
   * Initialize chat session with system prompt
   */
  async initialize(): Promise<void> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      systemInstruction: this.getSystemPrompt(),
    });

    this.chat = model.startChat({
      history: [],
    });

    this.isInitialized = true;
    console.log('✓ LLM Director initialized (Gemini 2.0 Flash)');
  }

  /**
   * Get LLM decision for current round
   */
  async getDecision(round: number, db: Database.Database): Promise<LLMDecision> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const prompt = this.buildPrompt(round, db);
      console.log(`\nLLM prompt length: ${prompt.length} characters`);

      const result = await this.chat.sendMessage(prompt);
      const responseText = result.response.text();

      // Parse JSON response (strip markdown if present)
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) || responseText.match(/([\s\S]*)/);
      const jsonText = jsonMatch ? jsonMatch[1].trim() : responseText.trim();

      const decision: LLMDecision = JSON.parse(jsonText);

      // Store current state for next round's change detection
      this.storePreviousState(db);

      return decision;
    } catch (error) {
      console.error('LLM Error:', error);
      return this.getFallbackDecision(round);
    }
  }

  /**
   * Build prompt for LLM (full state on round 1, changes only afterwards)
   */
  private buildPrompt(round: number, db: Database.Database): string {
    const gameState = db.prepare('SELECT * FROM game_state WHERE id = 1').get() as GameState;
    const hexagons = db.prepare('SELECT * FROM hexagons').all() as Hexagon[];

    if (round === 1) {
      // Full state for first round
      return this.buildFullStatePrompt(gameState, hexagons, round);
    } else {
      // Only changes for subsequent rounds
      return this.buildChangesPrompt(gameState, hexagons, round);
    }
  }

  /**
   * Build full state prompt (round 1 only)
   */
  private buildFullStatePrompt(gameState: GameState, hexagons: Hexagon[], round: number): string {
    const urbanHexes = hexagons.filter((h) => h.type === 'urban');
    const ruralHexes = hexagons.filter((h) => h.type === 'rural');

    const urbanPop = urbanHexes.reduce((sum, h) => sum + h.population, 0);
    const ruralPop = ruralHexes.reduce((sum, h) => sum + h.population, 0);
    const totalFood = hexagons.reduce((sum, h) => sum + h.food_stored_tons, 0);

    let prompt = `ROUND ${round} - INITIAL STATE

GLOBAL METRICS:
- Total Population: ${gameState.total_population.toLocaleString()} (${urbanPop.toLocaleString()} urban, ${ruralPop.toLocaleString()} rural)
- Total Food: ${totalFood.toFixed(0)} tons
- Deaths: ${gameState.total_deaths}

CRITICAL HEXAGONS (showing first 10 for context):
`;

    // Show 10 representative hexes
    for (let i = 0; i < Math.min(10, hexagons.length); i++) {
      const hex = hexagons[i];
      prompt += `${hex.id} [${hex.type}]: ${hex.population.toLocaleString()} pop, ${hex.food_stored_tons.toFixed(1)}t food, ${hex.water_availability.toFixed(0)}% water, infra ${((hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3).toFixed(0)}%, violence ${hex.violence_level}\n`;
    }

    prompt += `\n(${hexagons.length} total hexagons, 20 urban, 80 rural)

Your task: Decide weather and events for this round. Consider:
- Round ${round}/60: This is the beginning. Start with mild conditions.
- Progression: Rounds 1-10 should be relatively stable with minor degradation.
- Do NOT trigger severe events yet - build tension gradually.

Return JSON only (no markdown).`;

    return prompt;
  }

  /**
   * Build changes-only prompt (rounds 2+)
   */
  private buildChangesPrompt(gameState: GameState, hexagons: Hexagon[], round: number): string {
    const changes = this.detectSignificantChanges(hexagons);

    let prompt = `ROUND ${round} - STATE CHANGES

GLOBAL METRICS:
- Total Population: ${gameState.total_population.toLocaleString()} (Δ from initial: ${(gameState.total_population - 1000000).toLocaleString()})
- Total Food: ${gameState.total_food_tons.toFixed(0)} tons
- Total Deaths: ${gameState.total_deaths} (${gameState.deaths_starvation} starvation, ${gameState.deaths_transit} transit)

`;

    if (changes.length === 0) {
      prompt += `No significant changes since last round. System is stable.

`;
    } else {
      prompt += `SIGNIFICANT CHANGES (${changes.length} hexagons):\n`;
      for (const change of changes.slice(0, 15)) {
        // Limit to 15 most important
        prompt += `${change.hex_id}: pop ${change.current_state.population.toLocaleString()}`;
        if (change.population_change) prompt += ` (Δ${change.population_change > 0 ? '+' : ''}${change.population_change})`;
        if (change.food_change) prompt += `, food ${change.current_state.food.toFixed(1)}t (Δ${change.food_change.toFixed(1)}t)`;
        if (change.water_change) prompt += `, water ${change.current_state.water.toFixed(0)}% (Δ${change.water_change.toFixed(0)}%)`;
        prompt += `\n`;
      }
      prompt += `\n`;
    }

    // Progression guidance
    const progressPct = (round / 60) * 100;
    if (round <= 10) {
      prompt += `Progression: Early stage (${progressPct.toFixed(0)}%). Keep conditions relatively stable with gradual degradation.\n`;
    } else if (round <= 30) {
      prompt += `Progression: Mid-early stage (${progressPct.toFixed(0)}%). Increase pressure but avoid catastrophic events yet.\n`;
    } else if (round <= 40) {
      prompt += `Progression: Mid-late stage (${progressPct.toFixed(0)}%). Major challenges acceptable. Urban evacuation likely happening.\n`;
    } else {
      prompt += `Progression: Late stage (${progressPct.toFixed(0)}%). Harsh conditions expected. System approaching equilibrium or collapse.\n`;
    }

    prompt += `\nReturn JSON only (no markdown).`;

    return prompt;
  }

  /**
   * Detect significant changes between rounds
   */
  private detectSignificantChanges(hexagons: Hexagon[]): HexChange[] {
    const changes: HexChange[] = [];

    for (const hex of hexagons) {
      const prev = this.previousHexagons.get(hex.id);
      if (!prev) continue;

      const change: HexChange = {
        hex_id: hex.id,
        current_state: {
          population: hex.population,
          food: hex.food_stored_tons,
          water: hex.water_availability,
          power: hex.infrastructure_power,
          violence: hex.violence_level,
        },
      };

      let isSignificant = false;

      // Population change ±500
      const popDiff = hex.population - prev.population;
      if (Math.abs(popDiff) >= 500) {
        change.population_change = popDiff;
        isSignificant = true;
      }

      // Food change ±5 tons
      const foodDiff = hex.food_stored_tons - prev.food_stored_tons;
      if (Math.abs(foodDiff) >= 5) {
        change.food_change = foodDiff;
        isSignificant = true;
      }

      // Water change ±10%
      const waterDiff = hex.water_availability - prev.water_availability;
      if (Math.abs(waterDiff) >= 10) {
        change.water_change = waterDiff;
        isSignificant = true;
      }

      // Power change ±10%
      const powerDiff = hex.infrastructure_power - prev.infrastructure_power;
      if (Math.abs(powerDiff) >= 10) {
        change.power_change = powerDiff;
        isSignificant = true;
      }

      // Violence change ±2
      const violenceDiff = hex.violence_level - prev.violence_level;
      if (Math.abs(violenceDiff) >= 2) {
        change.violence_change = violenceDiff;
        isSignificant = true;
      }

      // Critical thresholds
      if (hex.food_stored_tons < 10 || hex.water_availability < 30) {
        isSignificant = true;
      }

      if (isSignificant) {
        changes.push(change);
      }
    }

    return changes;
  }

  /**
   * Store current state for next round's change detection
   */
  private storePreviousState(db: Database.Database): void {
    const hexagons = db.prepare('SELECT * FROM hexagons').all() as Hexagon[];
    this.previousHexagons.clear();
    for (const hex of hexagons) {
      this.previousHexagons.set(hex.id, { ...hex });
    }
  }

  /**
   * Get system prompt
   */
  private getSystemPrompt(): string {
    return `You are the Climate Crisis Director for ABBADON, a 60-round simulation of societal collapse in the Berlin-Brandenburg-MV region (~1M people, 100 hexagons).

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
- Reference previous events when building continuity

OUTPUT FORMAT (JSON only, no markdown):
{
  "weather": "heatwave",
  "weather_severity": 7,
  "weather_effects": {
    "water_impact": -25,
    "food_impact": -20,
    "infrastructure_impact": -15
  },
  "triggered_events": [
    {"hex_id": "HEX_003", "event_type": "violence", "severity": 8, "reason": "Food shortage critical"}
  ],
  "infrastructure_decay_multiplier": 1.8,
  "narrative": "Brutal heatwave strikes. Power grids failing. Violence erupts in HEX_003 as food runs out."
}

Remember: Build tension gradually. Early rounds should feel manageable. Late rounds should feel desperate.`;
  }

  /**
   * Fallback decision if LLM fails
   */
  private getFallbackDecision(round: number): LLMDecision {
    const severity = Math.min(10, Math.floor(1 + round / 6)); // Increases with round

    return {
      weather: 'deteriorating',
      weather_severity: severity,
      weather_effects: {
        water_impact: -severity * 2,
        food_impact: -severity * 1.5,
        infrastructure_impact: -severity,
      },
      triggered_events: [],
      infrastructure_decay_multiplier: 1 + round / 30,
      narrative: `System degrading (LLM unavailable). Automated deterioration severity ${severity}/10.`,
    };
  }
}
