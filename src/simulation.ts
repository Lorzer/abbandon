/**
 * ABBADON - Simulation Engine (in-memory)
 *
 * Operates directly on a WorldState object (no database). All tunable factors
 * are read from SimConfig. The force model computes each term as a normalized
 * 0-100 intensity times a configurable weight, so the pace and spatial texture
 * of collapse can be tuned without editing engine code.
 */

import type {
  Hexagon,
  GameState,
  LLMDecision,
  Edge,
  HexSnapshot,
  EventLog,
  ForceBreakdown,
  WorldState,
} from './types.js';
import type { Director } from './director.js';
import type { SimConfig } from './config.js';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class SimulationEngine {
  private state: WorldState;
  private config: SimConfig;
  private index: Map<string, Hexagon>;

  constructor(state: WorldState) {
    this.state = state;
    this.config = state.config;
    this.index = new Map(state.hexagons.map((h) => [h.id, h]));
  }

  getState(): WorldState {
    return this.state;
  }

  setConfig(config: SimConfig): void {
    this.config = config;
    this.state.config = config;
  }

  getConfig(): SimConfig {
    return this.config;
  }

  /**
   * Run a single simulation round.
   */
  async runRound(director: Director): Promise<GameState> {
    const gs = this.state.gameState;
    const currentRound = gs.current_round + 1;
    const populationBefore = this.totalPopulation();

    const decision = await director.getDecision(currentRound, this.state);

    this.applyWeatherEffects(decision);
    const diseaseDeaths = this.applyTriggeredEvents(decision, currentRound);
    this.applyInfrastructureDecay(decision.infrastructure_decay_multiplier);
    this.calculateAllForces();
    const { transitDeaths } = this.executePopulationFlows();
    this.consumeResources();
    this.produceResources(currentRound);
    const starvationDeaths = this.applyStarvation();

    this.updateGameState(currentRound, starvationDeaths, transitDeaths, diseaseDeaths);

    // Invariant: population must reconcile against deaths.
    const drift = populationBefore - (starvationDeaths + transitDeaths + diseaseDeaths) - this.totalPopulation();
    if (drift !== 0) {
      console.warn(`⚠ Population conservation drift on round ${currentRound}: drift=${drift}`);
    }

    this.saveHistorySnapshot(currentRound);
    this.logEvent(currentRound, null, 'narrative', decision.narrative, decision.weather_severity);

    return this.state.gameState;
  }

  private applyWeatherEffects(decision: LLMDecision): void {
    const { water_impact, food_impact, infrastructure_impact } = decision.weather_effects;
    for (const h of this.state.hexagons) {
      h.water_availability = clamp(h.water_availability + water_impact, 0, 100);
      h.food_stored_tons = Math.max(0, h.food_stored_tons * (1 + food_impact / 100));
      h.infrastructure_power = clamp(h.infrastructure_power + infrastructure_impact, 0, 100);
      h.infrastructure_water = clamp(h.infrastructure_water + infrastructure_impact, 0, 100);
      h.infrastructure_roads = clamp(h.infrastructure_roads + infrastructure_impact, 0, 100);
    }
  }

  /** Returns disease deaths so they can be counted in the global tally. */
  private applyTriggeredEvents(decision: LLMDecision, round: number): number {
    let diseaseDeaths = 0;
    for (const event of decision.triggered_events) {
      const hex = this.index.get(event.hex_id);
      if (!hex) continue;

      switch (event.event_type) {
        case 'violence':
          hex.violence_level = Math.min(10, hex.violence_level + event.severity / 2);
          hex.cohesion = Math.max(0, hex.cohesion - event.severity * 5);
          break;
        case 'disease': {
          const deaths = Math.floor(hex.population * (event.severity / 100));
          hex.population = Math.max(0, hex.population - deaths);
          diseaseDeaths += deaths;
          this.logEvent(round, event.hex_id, 'disease', event.reason, deaths);
          break;
        }
        case 'infrastructure_collapse':
          hex.infrastructure_power = Math.max(0, hex.infrastructure_power - event.severity * 10);
          hex.infrastructure_water = Math.max(0, hex.infrastructure_water - event.severity * 10);
          hex.infrastructure_roads = Math.max(0, hex.infrastructure_roads - event.severity * 10);
          break;
        case 'resource_discovery':
          hex.food_stored_tons += event.severity * 10;
          break;
      }
      this.logEvent(round, event.hex_id, event.event_type, event.reason, event.severity);
    }
    return diseaseDeaths;
  }

  private applyInfrastructureDecay(multiplier: number): void {
    const decay = this.config.decay.baseInfraPct * multiplier;
    for (const h of this.state.hexagons) {
      h.infrastructure_power = Math.max(0, h.infrastructure_power - decay);
      h.infrastructure_water = Math.max(0, h.infrastructure_water - decay);
      h.infrastructure_roads = Math.max(0, h.infrastructure_roads - decay);
    }
  }

  private calculateAllForces(): void {
    for (const hex of this.state.hexagons) {
      const b = this.calculateHexForces(hex);
      hex.attractor_force = b.attractor_total;
      hex.repulsor_force = b.repulsor_total;
      hex.net_force = b.net;
    }
  }

  /**
   * Force breakdown for a single hex. Each term is a normalized 0-100 intensity
   * times its configured weight.
   */
  calculateHexForces(hex: Hexagon): ForceBreakdown {
    const f = this.config.forces;
    const { perCapitaTonsPerMonth } = this.config.consumption;

    const foodPerCapita =
      hex.population > 0 ? hex.food_stored_tons / (hex.population * perCapitaTonsPerMonth) : 999;
    const avgInfra =
      (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3;
    const density = hex.area_km2 > 0 ? hex.population / hex.area_km2 : 0;
    const overcrowdingDensity = this.overcrowdingDensityFor(hex.type);

    const foodSurplus =
      f.foodSurplus.weight *
      clamp((foodPerCapita - f.foodSurplus.thresholdMonths) / f.foodSurplus.spanMonths, 0, 1) * 100;
    const water = f.waterAttract.weight * clamp(hex.water_availability, 0, 100);
    const infrastructure = f.infraAttract.weight * clamp(avgInfra, 0, 100);

    const securityNorm = clamp(
      (f.security.neutralViolence - hex.violence_level) / f.security.neutralViolence, -1, 1
    );
    const security = f.security.weight * securityNorm * 100;

    const foodShortage =
      f.foodShortage.weight *
      clamp((f.foodShortage.thresholdMonths - foodPerCapita) / f.foodShortage.thresholdMonths, 0, 1) * 100;
    const waterShortage =
      f.waterShortage.weight *
      clamp((f.waterShortage.thresholdPct - hex.water_availability) / f.waterShortage.thresholdPct, 0, 1) * 100;
    const overcrowding =
      f.overcrowding.weight * clamp((density - overcrowdingDensity) / overcrowdingDensity, 0, 1) * 100;
    const infrastructureCollapse =
      f.infraCollapse.weight *
      clamp((f.infraCollapse.thresholdPct - avgInfra) / f.infraCollapse.thresholdPct, 0, 1) * 100;

    const attractorTotal = foodSurplus + water + infrastructure + Math.max(0, security);
    const repulsorTotal =
      foodShortage + waterShortage + overcrowding + infrastructureCollapse + Math.max(0, -security);

    return {
      hex_id: hex.id,
      attractors: { food_surplus: foodSurplus, water, infrastructure },
      repulsors: {
        food_shortage: foodShortage,
        water_shortage: waterShortage,
        overcrowding,
        infrastructure_collapse: infrastructureCollapse,
      },
      security,
      attractor_total: attractorTotal,
      repulsor_total: repulsorTotal,
      net: attractorTotal - repulsorTotal,
    };
  }

  private overcrowdingDensityFor(type: 'urban' | 'rural'): number {
    return type === 'urban'
      ? this.config.world.urban.overcrowdingDensity
      : this.config.world.rural.overcrowdingDensity;
  }

  /**
   * Population flows between hexes. Returns total moved and transit deaths
   * (mortality rises as roads degrade).
   */
  private executePopulationFlows(): { totalMoved: number; transitDeaths: number } {
    const { leaveNetThreshold, maxLeavePct, leaveScale, transitMortality } = this.config.migration;
    const flows: { from: Hexagon; to: Hexagon; moved: number; deaths: number }[] = [];
    let totalMoved = 0;
    let transitDeaths = 0;

    for (const hex of this.state.hexagons) {
      if (hex.net_force >= leaveNetThreshold || hex.population <= 0) continue;

      const leavePercentage = Math.min(maxLeavePct, Math.abs(hex.net_force) / leaveScale);
      const leavingPopulation = Math.floor(hex.population * leavePercentage);
      if (leavingPopulation === 0) continue;

      const neighbors = this.state.edges
        .filter((e) => e.from_hex_id === hex.id)
        .map((e) => ({ hex: this.index.get(e.to_hex_id)!, edge: e }))
        .filter((n) => n.hex && n.hex.net_force > hex.net_force);
      if (neighbors.length === 0) continue;

      const withPerm = neighbors.map((n) => ({
        ...n,
        permeability: this.calculateEdgePermeability(hex, n.hex, n.edge),
      }));
      const totalPermeability = withPerm.reduce((sum, n) => sum + n.permeability, 0);
      if (totalPermeability === 0) continue;

      for (const neighbor of withPerm) {
        const share = neighbor.permeability / totalPermeability;
        const moving = Math.floor(leavingPopulation * share);
        if (moving <= 0) continue;

        const avgRoads = (hex.infrastructure_roads + neighbor.hex.infrastructure_roads) / 2;
        const mortalityRate = transitMortality * (1 - clamp(avgRoads, 0, 100) / 100);
        const deaths = Math.floor(moving * mortalityRate);

        flows.push({ from: hex, to: neighbor.hex, moved: moving, deaths });
        totalMoved += moving;
        transitDeaths += deaths;
      }
    }

    for (const flow of flows) {
      flow.from.population -= flow.moved; // everyone leaves the source
      flow.to.population += flow.moved - flow.deaths; // only survivors arrive
    }

    return { totalMoved, transitDeaths };
  }

  private calculateEdgePermeability(fromHex: Hexagon, toHex: Hexagon, edge: Edge): number {
    let permeability = edge.base_permeability;
    const avgRoads = (fromHex.infrastructure_roads + toHex.infrastructure_roads) / 2;
    permeability *= avgRoads / 100;
    if (toHex.violence_level > 6) permeability *= 0.5;
    const destDensity = toHex.area_km2 > 0 ? toHex.population / toHex.area_km2 : 0;
    const maxDensity = this.overcrowdingDensityFor(toHex.type) * 1.2;
    if (destDensity > maxDensity) permeability *= 0.3;
    return permeability;
  }

  private consumeResources(): void {
    const perCapita = this.config.consumption.perCapitaTonsPerMonth;
    for (const h of this.state.hexagons) {
      h.food_stored_tons = Math.max(0, h.food_stored_tons - h.population * perCapita);
    }
  }

  /**
   * Rural farming plus decaying urban "supply line" imports that give cities a
   * survivable window before they collapse.
   */
  private produceResources(round: number): void {
    const { farmersNeeded, urbanBaselineSupplyTons, urbanBaselineSupplyDecay } = this.config.production;
    const urbanSupply = urbanBaselineSupplyTons * Math.pow(urbanBaselineSupplyDecay, round - 1);

    for (const h of this.state.hexagons) {
      if (h.type === 'rural') {
        const avgInfra = (h.infrastructure_power + h.infrastructure_water) / 200; // 0-1
        const laborFactor = Math.min(1, h.population / farmersNeeded);
        h.food_stored_tons += h.food_production_per_month * avgInfra * laborFactor;
      } else {
        h.food_stored_tons += urbanSupply;
      }
    }
  }

  private applyStarvation(): number {
    const threshold = this.config.starvation.foodThresholdTons;
    const rate = this.config.starvation.deathRate;
    let totalDeaths = 0;
    for (const h of this.state.hexagons) {
      if (h.food_stored_tons >= threshold) continue;
      const deaths = Math.floor(h.population * rate);
      h.population = Math.max(0, h.population - deaths);
      totalDeaths += deaths;
    }
    return totalDeaths;
  }

  private updateGameState(round: number, starvationDeaths: number, transitDeaths: number, otherDeaths: number): void {
    const gs = this.state.gameState;
    gs.current_round = round;
    gs.total_population = this.totalPopulation();
    gs.total_food_tons = this.state.hexagons.reduce((sum, h) => sum + h.food_stored_tons, 0);
    gs.total_deaths += starvationDeaths + transitDeaths + otherDeaths;
    gs.deaths_starvation += starvationDeaths;
    gs.deaths_transit += transitDeaths;
  }

  private saveHistorySnapshot(round: number): void {
    for (const hex of this.state.hexagons) {
      this.state.history.push({
        round,
        hex_id: hex.id,
        population: hex.population,
        food_stored_tons: hex.food_stored_tons,
        water_availability: hex.water_availability,
        infrastructure_avg:
          (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3,
        violence_level: hex.violence_level,
        net_force: hex.net_force,
      });
    }
  }

  /**
   * Restore hex state from a recorded round and truncate history/events after
   * it. Used by "fork" to re-simulate forward.
   */
  forkFromRound(round: number): GameState {
    const snaps = this.state.history.filter((s) => s.round === round);
    if (snaps.length === 0) throw new Error(`No history snapshot for round ${round}`);

    for (const s of snaps) {
      const hex = this.index.get(s.hex_id);
      if (!hex) continue;
      hex.population = s.population;
      hex.food_stored_tons = s.food_stored_tons;
      hex.water_availability = s.water_availability;
      hex.net_force = s.net_force;
    }

    this.state.history = this.state.history.filter((s) => s.round <= round);
    this.state.events = this.state.events.filter((e) => e.round <= round);

    const gs = this.state.gameState;
    gs.current_round = round;
    gs.total_population = this.totalPopulation();
    gs.total_food_tons = this.state.hexagons.reduce((sum, h) => sum + h.food_stored_tons, 0);
    return gs;
  }

  private logEvent(
    round: number,
    hexId: string | null,
    eventType: string,
    description: string,
    impactValue: number
  ): void {
    this.state.events.push({ round, hex_id: hexId, event_type: eventType, description, impact_value: impactValue });
  }

  private totalPopulation(): number {
    return this.state.hexagons.reduce((sum, h) => sum + h.population, 0);
  }

  // --- accessors ---
  getGameState(): GameState {
    return this.state.gameState;
  }
  getHexagon(id: string): Hexagon | undefined {
    return this.index.get(id);
  }
  getAllHexagons(): Hexagon[] {
    return this.state.hexagons;
  }
  getHistoryForRound(round: number): HexSnapshot[] {
    return this.state.history.filter((s) => s.round === round).sort((a, b) => a.hex_id.localeCompare(b.hex_id));
  }
  getEventsForRound(round: number): EventLog[] {
    return this.state.events.filter((e) => e.round === round);
  }
  getRecentEvents(limit: number = 10): EventLog[] {
    return this.state.events.slice(-limit).reverse();
  }
}
