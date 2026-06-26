/**
 * ABBADON - Simulation Engine
 *
 * All tunable factors are read from SimConfig (see config.ts). The force model
 * computes each term as a normalized 0-100 intensity times a configurable
 * weight, so the pace and spatial texture of collapse can be tuned without
 * editing engine code.
 */

import Database from 'better-sqlite3';
import type {
  Hexagon,
  GameState,
  LLMDecision,
  Edge,
  HexSnapshot,
  EventLog,
  ForceBreakdown,
} from './types.js';
import type { Director } from './director.js';
import type { SimConfig } from './config.js';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class SimulationEngine {
  private db: Database.Database;
  private config: SimConfig;

  constructor(db: Database.Database, config: SimConfig) {
    this.db = db;
    this.config = config;
  }

  setConfig(config: SimConfig): void {
    this.config = config;
  }

  getConfig(): SimConfig {
    return this.config;
  }

  /**
   * Run a single simulation round.
   */
  async runRound(director: Director): Promise<GameState> {
    const gameState = this.getGameState();
    const currentRound = gameState.current_round + 1;

    console.log(`\n=== ROUND ${currentRound} ===`);

    const populationBefore = this.totalPopulation();

    // 1. Get director decision (LLM or scripted)
    const decision = await director.getDecision(currentRound, this.db);
    console.log(`Weather: ${decision.weather} (severity ${decision.weather_severity})`);
    console.log(`Narrative: ${decision.narrative}`);

    // 2. Apply weather effects (global)
    this.applyWeatherEffects(decision);

    // 3. Apply triggered events (specific hexes) -> may kill via disease
    const diseaseDeaths = this.applyTriggeredEvents(decision, currentRound);

    // 4. Apply infrastructure decay
    this.applyInfrastructureDecay(decision.infrastructure_decay_multiplier);

    // 5. Calculate forces for all hexes
    this.calculateAllForces();

    // 6. Execute population flows (with transit mortality)
    const { totalMoved, transitDeaths } = this.executePopulationFlows();
    console.log(`Population flows: ${totalMoved} moved, ${transitDeaths} died in transit`);

    // 7. Consume resources
    this.consumeResources();

    // 8. Produce resources (rural farming + decaying urban supply lines)
    this.produceResources(currentRound);

    // 9. Apply starvation
    const starvationDeaths = this.applyStarvation();
    console.log(`Starvation deaths: ${starvationDeaths}`);

    // 10. Update game state
    const newGameState = this.updateGameState(currentRound, starvationDeaths, transitDeaths, diseaseDeaths);

    // 11. Invariant check: population must reconcile against deaths.
    const populationAfter = this.totalPopulation();
    const accountedDeaths = starvationDeaths + transitDeaths + diseaseDeaths;
    const drift = populationBefore - accountedDeaths - populationAfter;
    if (drift !== 0) {
      console.warn(
        `⚠ Population conservation drift on round ${currentRound}: ` +
          `before=${populationBefore} deaths=${accountedDeaths} after=${populationAfter} drift=${drift}`
      );
    }

    // 12. Save history snapshot + narrative
    this.saveHistorySnapshot(currentRound, newGameState.run_id);
    this.logEvent(currentRound, null, 'narrative', decision.narrative, decision.weather_severity);

    return newGameState;
  }

  /**
   * Apply global weather effects to all hexagons.
   */
  private applyWeatherEffects(decision: LLMDecision): void {
    const { water_impact, food_impact, infrastructure_impact } = decision.weather_effects;

    this.db
      .prepare(
        `UPDATE hexagons SET
        water_availability = MAX(0, MIN(100, water_availability + ?)),
        food_stored_tons = MAX(0, food_stored_tons * (1 + ? / 100)),
        infrastructure_power = MAX(0, MIN(100, infrastructure_power + ?)),
        infrastructure_water = MAX(0, MIN(100, infrastructure_water + ?)),
        infrastructure_roads = MAX(0, MIN(100, infrastructure_roads + ?))`
      )
      .run(water_impact, food_impact, infrastructure_impact, infrastructure_impact, infrastructure_impact);
  }

  /**
   * Apply triggered events to specific hexagons. Returns disease deaths so they
   * can be accounted for in the global death tally.
   */
  private applyTriggeredEvents(decision: LLMDecision, round: number): number {
    let diseaseDeaths = 0;

    for (const event of decision.triggered_events) {
      const hex = this.getHexagon(event.hex_id);
      if (!hex) continue;

      switch (event.event_type) {
        case 'violence':
          this.db
            .prepare(
              `UPDATE hexagons SET
                violence_level = MIN(10, violence_level + ?),
                cohesion = MAX(0, cohesion - ?)
              WHERE id = ?`
            )
            .run(event.severity / 2, event.severity * 5, event.hex_id);
          break;

        case 'disease': {
          const deaths = Math.floor(hex.population * (event.severity / 100));
          this.db
            .prepare(`UPDATE hexagons SET population = MAX(0, population - ?) WHERE id = ?`)
            .run(deaths, event.hex_id);
          diseaseDeaths += deaths;
          this.logEvent(round, event.hex_id, 'disease', event.reason, deaths);
          break;
        }

        case 'infrastructure_collapse':
          this.db
            .prepare(
              `UPDATE hexagons SET
                infrastructure_power = MAX(0, infrastructure_power - ?),
                infrastructure_water = MAX(0, infrastructure_water - ?),
                infrastructure_roads = MAX(0, infrastructure_roads - ?)
              WHERE id = ?`
            )
            .run(event.severity * 10, event.severity * 10, event.severity * 10, event.hex_id);
          break;

        case 'resource_discovery':
          this.db
            .prepare(`UPDATE hexagons SET food_stored_tons = food_stored_tons + ? WHERE id = ?`)
            .run(event.severity * 10, event.hex_id);
          break;
      }

      this.logEvent(round, event.hex_id, event.event_type, event.reason, event.severity);
    }

    return diseaseDeaths;
  }

  /**
   * Apply infrastructure decay.
   */
  private applyInfrastructureDecay(multiplier: number): void {
    const decay = this.config.decay.baseInfraPct * multiplier;

    this.db
      .prepare(
        `UPDATE hexagons SET
        infrastructure_power = MAX(0, infrastructure_power - ?),
        infrastructure_water = MAX(0, infrastructure_water - ?),
        infrastructure_roads = MAX(0, infrastructure_roads - ?)`
      )
      .run(decay, decay, decay);
  }

  /**
   * Calculate forces (attractors vs repulsors) for all hexagons.
   */
  private calculateAllForces(): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];

    const updateStmt = this.db.prepare(
      `UPDATE hexagons SET attractor_force = ?, repulsor_force = ?, net_force = ? WHERE id = ?`
    );

    const updateMany = this.db.transaction((breakdowns: ForceBreakdown[]) => {
      for (const b of breakdowns) {
        updateStmt.run(b.attractor_total, b.repulsor_total, b.net, b.hex_id);
      }
    });

    updateMany(hexagons.map((hex) => this.calculateHexForces(hex)));
  }

  /**
   * Calculate the force breakdown for a single hexagon. Each term is a
   * normalized 0-100 intensity times its configured weight.
   */
  calculateHexForces(hex: Hexagon): ForceBreakdown {
    const f = this.config.forces;
    const { perCapitaTonsPerMonth } = this.config.consumption;

    // Months of food on hand (Infinity-ish when empty so shortage doesn't fire).
    const foodPerCapita =
      hex.population > 0 ? hex.food_stored_tons / (hex.population * perCapitaTonsPerMonth) : 999;
    const avgInfra =
      (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3;
    const density = hex.area_km2 > 0 ? hex.population / hex.area_km2 : 0;
    const overcrowdingDensity = this.overcrowdingDensityFor(hex.type);

    // --- Attractors (0-100 intensity * weight) ---
    const foodSurplus =
      f.foodSurplus.weight *
      clamp((foodPerCapita - f.foodSurplus.thresholdMonths) / f.foodSurplus.spanMonths, 0, 1) * 100;
    const water = f.waterAttract.weight * clamp(hex.water_availability, 0, 100);
    const infrastructure = f.infraAttract.weight * clamp(avgInfra, 0, 100);

    // --- Security: single signed term (replaces old safety/violence double-count) ---
    const securityNorm = clamp((f.security.neutralViolence - hex.violence_level) / f.security.neutralViolence, -1, 1);
    const security = f.security.weight * securityNorm * 100;

    // --- Repulsors (0-100 intensity * weight) ---
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
    const net = attractorTotal - repulsorTotal;

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
      net,
    };
  }

  private overcrowdingDensityFor(type: 'urban' | 'rural'): number {
    return type === 'urban'
      ? this.config.world.urban.overcrowdingDensity
      : this.config.world.rural.overcrowdingDensity;
  }

  /**
   * Execute population flows between hexagons. Returns total moved and how many
   * died in transit (transit mortality rises as roads degrade).
   */
  private executePopulationFlows(): { totalMoved: number; transitDeaths: number } {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];
    const edges = this.db.prepare('SELECT * FROM edges').all() as Edge[];
    const { leaveNetThreshold, maxLeavePct, leaveScale, transitMortality } = this.config.migration;

    const flows: { from: string; to: string; moved: number; deaths: number }[] = [];
    let totalMoved = 0;
    let transitDeaths = 0;

    for (const hex of hexagons) {
      if (hex.net_force >= leaveNetThreshold || hex.population <= 0) continue;

      const leavePercentage = Math.min(maxLeavePct, Math.abs(hex.net_force) / leaveScale);
      const leavingPopulation = Math.floor(hex.population * leavePercentage);
      if (leavingPopulation === 0) continue;

      const neighbors = edges
        .filter((e) => e.from_hex_id === hex.id)
        .map((e) => ({ hex: hexagons.find((h) => h.id === e.to_hex_id)!, edge: e }))
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

        // Transit mortality scales with how degraded the roads are.
        const avgRoads = (hex.infrastructure_roads + neighbor.hex.infrastructure_roads) / 2;
        const mortalityRate = transitMortality * (1 - clamp(avgRoads, 0, 100) / 100);
        const deaths = Math.floor(moving * mortalityRate);

        flows.push({ from: hex.id, to: neighbor.hex.id, moved: moving, deaths });
        totalMoved += moving;
        transitDeaths += deaths;
      }
    }

    const removeStmt = this.db.prepare('UPDATE hexagons SET population = population - ? WHERE id = ?');
    const addStmt = this.db.prepare('UPDATE hexagons SET population = population + ? WHERE id = ?');
    const applyFlows = this.db.transaction((flowList: typeof flows) => {
      for (const flow of flowList) {
        removeStmt.run(flow.moved, flow.from); // everyone leaves the source
        addStmt.run(flow.moved - flow.deaths, flow.to); // only survivors arrive
      }
    });
    applyFlows(flows);

    return { totalMoved, transitDeaths };
  }

  /**
   * Calculate edge permeability (how easily people can move).
   */
  private calculateEdgePermeability(fromHex: Hexagon, toHex: Hexagon, edge: Edge): number {
    let permeability = edge.base_permeability;

    // Roads help movement.
    const avgRoads = (fromHex.infrastructure_roads + toHex.infrastructure_roads) / 2;
    permeability *= avgRoads / 100;

    // Violence reduces movement into a hex.
    if (toHex.violence_level > 6) permeability *= 0.5;

    // Don't pour people into an already-overcrowded destination.
    const destDensity = toHex.area_km2 > 0 ? toHex.population / toHex.area_km2 : 0;
    const maxDensity = this.overcrowdingDensityFor(toHex.type) * 1.2;
    if (destDensity > maxDensity) permeability *= 0.3;

    return permeability;
  }

  /**
   * Consume resources (everyone needs food).
   */
  private consumeResources(): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];
    const perCapita = this.config.consumption.perCapitaTonsPerMonth;
    const updateStmt = this.db.prepare('UPDATE hexagons SET food_stored_tons = ? WHERE id = ?');

    const updates = this.db.transaction((hexList: Hexagon[]) => {
      for (const hex of hexList) {
        const foodNeeded = hex.population * perCapita;
        updateStmt.run(Math.max(0, hex.food_stored_tons - foodNeeded), hex.id);
      }
    });
    updates(hexagons);
  }

  /**
   * Produce resources: rural farming, plus decaying urban "supply line" imports
   * that give cities a survivable window before they collapse.
   */
  private produceResources(round: number): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];
    const { farmersNeeded, urbanBaselineSupplyTons, urbanBaselineSupplyDecay } = this.config.production;
    const urbanSupply = urbanBaselineSupplyTons * Math.pow(urbanBaselineSupplyDecay, round - 1);

    const updateStmt = this.db.prepare('UPDATE hexagons SET food_stored_tons = food_stored_tons + ? WHERE id = ?');

    const updates = this.db.transaction((hexList: Hexagon[]) => {
      for (const hex of hexList) {
        let gain = 0;
        if (hex.type === 'rural') {
          const avgInfra = (hex.infrastructure_power + hex.infrastructure_water) / 200; // 0-1
          const laborFactor = Math.min(1, hex.population / farmersNeeded);
          gain = hex.food_production_per_month * avgInfra * laborFactor;
        } else {
          // Urban hexes survive on imports that dwindle as the wider world fails.
          gain = urbanSupply;
        }
        if (gain !== 0) updateStmt.run(gain, hex.id);
      }
    });
    updates(hexagons);
  }

  /**
   * Apply starvation to hexes with effectively no food.
   */
  private applyStarvation(): number {
    const threshold = this.config.starvation.foodThresholdTons;
    const rate = this.config.starvation.deathRate;
    const hexagons = this.db
      .prepare('SELECT * FROM hexagons WHERE food_stored_tons < ?')
      .all(threshold) as Hexagon[];

    let totalDeaths = 0;
    const updateStmt = this.db.prepare('UPDATE hexagons SET population = ? WHERE id = ?');

    const updates = this.db.transaction((hexList: Hexagon[]) => {
      for (const hex of hexList) {
        const deaths = Math.floor(hex.population * rate);
        totalDeaths += deaths;
        updateStmt.run(Math.max(0, hex.population - deaths), hex.id);
      }
    });
    updates(hexagons);

    return totalDeaths;
  }

  /**
   * Update game state.
   */
  private updateGameState(
    round: number,
    starvationDeaths: number,
    transitDeaths: number,
    otherDeaths: number
  ): GameState {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];
    const totalPopulation = hexagons.reduce((sum, h) => sum + h.population, 0);
    const totalFood = hexagons.reduce((sum, h) => sum + h.food_stored_tons, 0);

    const current = this.getGameState();

    this.db
      .prepare(
        `UPDATE game_state SET
        current_round = ?,
        total_population = ?,
        total_food_tons = ?,
        total_deaths = ?,
        deaths_starvation = ?,
        deaths_transit = ?
      WHERE id = 1`
      )
      .run(
        round,
        totalPopulation,
        totalFood,
        current.total_deaths + starvationDeaths + transitDeaths + otherDeaths,
        current.deaths_starvation + starvationDeaths,
        current.deaths_transit + transitDeaths
      );

    return this.getGameState();
  }

  /**
   * Save history snapshot.
   */
  private saveHistorySnapshot(round: number, runId: string): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO history (
        run_id, round, hex_id, population, food_stored_tons, water_availability,
        infrastructure_avg, violence_level, net_force
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertMany = this.db.transaction((snapshots: (HexSnapshot & { run_id: string })[]) => {
      for (const s of snapshots) {
        stmt.run(
          s.run_id,
          s.round,
          s.hex_id,
          s.population,
          s.food_stored_tons,
          s.water_availability,
          s.infrastructure_avg,
          s.violence_level,
          s.net_force
        );
      }
    });

    insertMany(
      hexagons.map((hex) => ({
        run_id: runId,
        round,
        hex_id: hex.id,
        population: hex.population,
        food_stored_tons: hex.food_stored_tons,
        water_availability: hex.water_availability,
        infrastructure_avg:
          (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3,
        violence_level: hex.violence_level,
        net_force: hex.net_force,
      }))
    );
  }

  /**
   * Restore all hexagon population/resource state from a recorded snapshot, and
   * truncate history after that round. Used by "fork" to re-simulate forward.
   */
  forkFromRound(round: number): GameState {
    const state = this.getGameState();
    const snaps = this.db
      .prepare('SELECT * FROM history WHERE run_id = ? AND round = ?')
      .all(state.run_id, round) as (HexSnapshot & { run_id: string })[];
    if (snaps.length === 0) {
      throw new Error(`No history snapshot for round ${round} in run ${state.run_id}`);
    }

    const restore = this.db.prepare(
      `UPDATE hexagons SET population = ?, food_stored_tons = ?, water_availability = ?, net_force = ? WHERE id = ?`
    );
    const apply = this.db.transaction((rows: (HexSnapshot & { run_id: string })[]) => {
      for (const s of rows) {
        restore.run(s.population, s.food_stored_tons, s.water_availability, s.net_force, s.hex_id);
      }
    });
    apply(snaps);

    // Drop everything after the fork point and rewind the clock.
    this.db.prepare('DELETE FROM history WHERE run_id = ? AND round > ?').run(state.run_id, round);
    this.db.prepare('DELETE FROM events WHERE round > ?').run(round);

    const totalPopulation = (this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[]).reduce(
      (sum, h) => sum + h.population,
      0
    );
    const totalFood = (this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[]).reduce(
      (sum, h) => sum + h.food_stored_tons,
      0
    );
    this.db
      .prepare('UPDATE game_state SET current_round = ?, total_population = ?, total_food_tons = ? WHERE id = 1')
      .run(round, totalPopulation, totalFood);

    return this.getGameState();
  }

  /**
   * Log event.
   */
  private logEvent(
    round: number,
    hexId: string | null,
    eventType: string,
    description: string,
    impactValue: number
  ): void {
    this.db
      .prepare(`INSERT INTO events (round, hex_id, event_type, description, impact_value) VALUES (?, ?, ?, ?, ?)`)
      .run(round, hexId, eventType, description, impactValue);
  }

  private totalPopulation(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(population), 0) AS total FROM hexagons').get() as {
      total: number;
    };
    return row.total;
  }

  getGameState(): GameState {
    return this.db.prepare('SELECT * FROM game_state WHERE id = 1').get() as GameState;
  }

  getHexagon(id: string): Hexagon | undefined {
    return this.db.prepare('SELECT * FROM hexagons WHERE id = ?').get(id) as Hexagon | undefined;
  }

  getAllHexagons(): Hexagon[] {
    return this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];
  }

  getHistoryForRound(round: number): (HexSnapshot & { run_id: string })[] {
    const state = this.getGameState();
    return this.db
      .prepare('SELECT * FROM history WHERE run_id = ? AND round = ? ORDER BY hex_id')
      .all(state.run_id, round) as (HexSnapshot & { run_id: string })[];
  }

  getRecentEvents(limit: number = 10): EventLog[] {
    return this.db.prepare(`SELECT * FROM events ORDER BY round DESC, id DESC LIMIT ?`).all(limit) as EventLog[];
  }
}
