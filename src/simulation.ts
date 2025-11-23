/**
 * ABBADON Phase 1 - Simulation Engine
 */

import Database from 'better-sqlite3';
import type {
  Hexagon,
  GameState,
  LLMDecision,
  Forces,
  PopulationFlow,
  Edge,
  HexSnapshot,
  EventLog,
} from './types.js';
import type { LLMDirector } from './llm.js';

export class SimulationEngine {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Run a single simulation round
   */
  async runRound(llmDirector: LLMDirector): Promise<GameState> {
    const gameState = this.getGameState();
    const currentRound = gameState.current_round + 1;

    console.log(`\n=== ROUND ${currentRound} ===`);

    // 1. Get LLM decision
    const llmDecision = await llmDirector.getDecision(currentRound, this.db);
    console.log(`Weather: ${llmDecision.weather} (severity ${llmDecision.weather_severity})`);
    console.log(`Narrative: ${llmDecision.narrative}`);

    // 2. Apply weather effects (global)
    this.applyWeatherEffects(llmDecision);

    // 3. Apply triggered events (specific hexes)
    this.applyTriggeredEvents(llmDecision, currentRound);

    // 4. Apply infrastructure decay
    this.applyInfrastructureDecay(llmDecision.infrastructure_decay_multiplier);

    // 5. Calculate forces for all hexes
    this.calculateAllForces();

    // 6. Execute population flows
    const totalFlows = this.executePopulationFlows();
    console.log(`Population flows: ${totalFlows} people moved`);

    // 7. Consume resources
    this.consumeResources();

    // 8. Produce resources
    this.produceResources();

    // 9. Apply starvation
    const starvationDeaths = this.applyStarvation();
    console.log(`Starvation deaths: ${starvationDeaths}`);

    // 10. Update game state
    const newGameState = this.updateGameState(currentRound, starvationDeaths, 0);

    // 11. Save history snapshot
    this.saveHistorySnapshot(currentRound);

    // 12. Log narrative event
    this.logEvent(currentRound, null, 'narrative', llmDecision.narrative, llmDecision.weather_severity);

    return newGameState;
  }

  /**
   * Apply global weather effects to all hexagons
   */
  private applyWeatherEffects(decision: LLMDecision): void {
    const { water_impact, food_impact, infrastructure_impact } = decision.weather_effects;

    this.db.prepare(`
      UPDATE hexagons SET
        water_availability = MAX(0, MIN(100, water_availability + ?)),
        food_stored_tons = MAX(0, food_stored_tons * (1 + ? / 100)),
        infrastructure_power = MAX(0, MIN(100, infrastructure_power + ?)),
        infrastructure_water = MAX(0, MIN(100, infrastructure_water + ?)),
        infrastructure_roads = MAX(0, MIN(100, infrastructure_roads + ?))
    `).run(
      water_impact,
      food_impact,
      infrastructure_impact,
      infrastructure_impact,
      infrastructure_impact
    );
  }

  /**
   * Apply triggered events to specific hexagons
   */
  private applyTriggeredEvents(decision: LLMDecision, round: number): void {
    for (const event of decision.triggered_events) {
      const hex = this.getHexagon(event.hex_id);
      if (!hex) continue;

      switch (event.event_type) {
        case 'violence':
          this.db.prepare(`
            UPDATE hexagons SET
              violence_level = MIN(10, violence_level + ?),
              cohesion = MAX(0, cohesion - ?)
            WHERE id = ?
          `).run(event.severity / 2, event.severity * 5, event.hex_id);
          break;

        case 'disease':
          const deaths = Math.floor(hex.population * (event.severity / 100));
          this.db.prepare(`
            UPDATE hexagons SET population = MAX(0, population - ?)
            WHERE id = ?
          `).run(deaths, event.hex_id);
          this.logEvent(round, event.hex_id, 'disease', event.reason, deaths);
          break;

        case 'infrastructure_collapse':
          this.db.prepare(`
            UPDATE hexagons SET
              infrastructure_power = MAX(0, infrastructure_power - ?),
              infrastructure_water = MAX(0, infrastructure_water - ?),
              infrastructure_roads = MAX(0, infrastructure_roads - ?)
            WHERE id = ?
          `).run(event.severity * 10, event.severity * 10, event.severity * 10, event.hex_id);
          break;

        case 'resource_discovery':
          this.db.prepare(`
            UPDATE hexagons SET food_stored_tons = food_stored_tons + ?
            WHERE id = ?
          `).run(event.severity * 10, event.hex_id);
          break;
      }

      this.logEvent(round, event.hex_id, event.event_type, event.reason, event.severity);
    }
  }

  /**
   * Apply infrastructure decay (increases over time)
   */
  private applyInfrastructureDecay(multiplier: number): void {
    const baseDecay = 0.5; // 0.5% per month
    const decay = baseDecay * multiplier;

    this.db.prepare(`
      UPDATE hexagons SET
        infrastructure_power = MAX(0, infrastructure_power - ?),
        infrastructure_water = MAX(0, infrastructure_water - ?),
        infrastructure_roads = MAX(0, infrastructure_roads - ?)
    `).run(decay, decay, decay);
  }

  /**
   * Calculate forces (attractors vs repulsors) for all hexagons
   */
  private calculateAllForces(): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];

    const updateStmt = this.db.prepare(`
      UPDATE hexagons SET
        attractor_force = ?,
        repulsor_force = ?,
        net_force = ?
      WHERE id = ?
    `);

    const updateMany = this.db.transaction((updates: any[]) => {
      for (const u of updates) {
        updateStmt.run(u.attractor, u.repulsor, u.net, u.id);
      }
    });

    const updates = hexagons.map((hex) => {
      const forces = this.calculateHexForces(hex);
      return {
        id: hex.id,
        attractor: forces.attractors.food_surplus + forces.attractors.water_availability +
                   forces.attractors.infrastructure_quality + forces.attractors.safety,
        repulsor: forces.repulsors.food_shortage + forces.repulsors.water_shortage +
                  forces.repulsors.violence + forces.repulsors.overcrowding +
                  forces.repulsors.infrastructure_collapse,
        net: forces.net,
      };
    });

    updateMany(updates);
  }

  /**
   * Calculate forces for a single hexagon
   */
  private calculateHexForces(hex: Hexagon): Forces {
    const forces: Forces = {
      attractors: {
        food_surplus: 0,
        water_availability: 0,
        infrastructure_quality: 0,
        safety: 0,
      },
      repulsors: {
        food_shortage: 0,
        water_shortage: 0,
        violence: 0,
        overcrowding: 0,
        infrastructure_collapse: 0,
      },
      net: 0,
    };

    // Attractors
    const foodPerCapita = hex.population > 0 ? hex.food_stored_tons / (hex.population * 0.002) : 0; // Months of food
    if (foodPerCapita > 3) {
      forces.attractors.food_surplus = Math.min(50, (foodPerCapita - 3) * 10);
    }

    forces.attractors.water_availability = hex.water_availability / 2;
    forces.attractors.infrastructure_quality = (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 6;
    forces.attractors.safety = (10 - hex.violence_level) * 5;

    // Repulsors
    if (foodPerCapita < 1) {
      forces.repulsors.food_shortage = (1 - foodPerCapita) * 100;
    }

    if (hex.water_availability < 50) {
      forces.repulsors.water_shortage = (50 - hex.water_availability) * 2;
    }

    forces.repulsors.violence = hex.violence_level * 10;

    const density = hex.population / hex.area_km2;
    const overcrowdingThreshold = hex.type === 'urban' ? 5000 : 100;
    if (density > overcrowdingThreshold) {
      forces.repulsors.overcrowding = Math.min(100, (density - overcrowdingThreshold) / overcrowdingThreshold * 50);
    }

    const avgInfra = (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3;
    if (avgInfra < 30) {
      forces.repulsors.infrastructure_collapse = (30 - avgInfra) * 3;
    }

    // Net force
    const totalAttractors = Object.values(forces.attractors).reduce((a, b) => a + b, 0);
    const totalRepulsors = Object.values(forces.repulsors).reduce((a, b) => a + b, 0);
    forces.net = totalAttractors - totalRepulsors;

    return forces;
  }

  /**
   * Execute population flows between hexagons
   */
  private executePopulationFlows(): number {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];
    const edges = this.db.prepare('SELECT * FROM edges').all() as Edge[];

    const flows: PopulationFlow[] = [];
    let totalMoved = 0;

    // Find hexes with negative force (people want to leave)
    for (const hex of hexagons) {
      if (hex.net_force < -20 && hex.population > 0) {
        // Calculate how many want to leave
        const leavePercentage = Math.min(0.2, Math.abs(hex.net_force) / 500); // Max 20% per month
        const leavingPopulation = Math.floor(hex.population * leavePercentage);

        if (leavingPopulation === 0) continue;

        // Find neighbors
        const neighborEdges = edges.filter((e) => e.from_hex_id === hex.id);
        const neighbors = neighborEdges
          .map((e) => ({
            hex: hexagons.find((h) => h.id === e.to_hex_id)!,
            edge: e,
          }))
          .filter((n) => n.hex && n.hex.net_force > hex.net_force);

        if (neighbors.length === 0) continue;

        // Calculate permeability for each neighbor
        const neighborsWithPermeability = neighbors.map((n) => ({
          ...n,
          permeability: this.calculateEdgePermeability(hex, n.hex, n.edge),
        }));

        const totalPermeability = neighborsWithPermeability.reduce((sum, n) => sum + n.permeability, 0);

        if (totalPermeability === 0) continue;

        // Distribute leaving population to neighbors
        for (const neighbor of neighborsWithPermeability) {
          const share = neighbor.permeability / totalPermeability;
          const movingPopulation = Math.floor(leavingPopulation * share);

          if (movingPopulation > 0) {
            flows.push({
              from_hex_id: hex.id,
              to_hex_id: neighbor.hex.id,
              population_count: movingPopulation,
              permeability: neighbor.permeability,
            });
            totalMoved += movingPopulation;
          }
        }
      }
    }

    // Apply flows
    const updateStmt = this.db.prepare('UPDATE hexagons SET population = population + ? WHERE id = ?');
    const applyFlows = this.db.transaction((flowList: PopulationFlow[]) => {
      for (const flow of flowList) {
        updateStmt.run(-flow.population_count, flow.from_hex_id); // Remove from source
        updateStmt.run(flow.population_count, flow.to_hex_id); // Add to destination
      }
    });

    applyFlows(flows);

    return totalMoved;
  }

  /**
   * Calculate edge permeability (how easily people can move)
   */
  private calculateEdgePermeability(fromHex: Hexagon, toHex: Hexagon, edge: Edge): number {
    let permeability = edge.base_permeability;

    // Roads help movement
    const avgRoads = (fromHex.infrastructure_roads + toHex.infrastructure_roads) / 2;
    permeability *= avgRoads / 100;

    // Violence reduces movement
    if (toHex.violence_level > 6) {
      permeability *= 0.5;
    }

    // Don't overcrowd destination
    const destDensity = toHex.population / toHex.area_km2;
    const maxDensity = toHex.type === 'urban' ? 6000 : 150;
    if (destDensity > maxDensity) {
      permeability *= 0.3;
    }

    return permeability;
  }

  /**
   * Consume resources (everyone needs food)
   */
  private consumeResources(): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];

    const updateStmt = this.db.prepare('UPDATE hexagons SET food_stored_tons = ? WHERE id = ?');

    const updates = this.db.transaction((hexList: Hexagon[]) => {
      for (const hex of hexList) {
        const foodNeeded = hex.population * 0.002; // 2kg per person per month
        const newFood = Math.max(0, hex.food_stored_tons - foodNeeded);
        updateStmt.run(newFood, hex.id);
      }
    });

    updates(hexagons);
  }

  /**
   * Produce resources (rural hexes produce food)
   */
  private produceResources(): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons WHERE type = "rural"').all() as Hexagon[];

    const updateStmt = this.db.prepare('UPDATE hexagons SET food_stored_tons = food_stored_tons + ? WHERE id = ?');

    const updates = this.db.transaction((hexList: Hexagon[]) => {
      for (const hex of hexList) {
        // Production depends on: base production × infrastructure × farmers present
        const avgInfra = (hex.infrastructure_power + hex.infrastructure_water) / 200; // 0-1
        const farmersNeeded = 100; // Arbitrary: need 100 people to work the land
        const laborFactor = Math.min(1, hex.population / farmersNeeded);

        const production = hex.food_production_per_month * avgInfra * laborFactor;
        updateStmt.run(production, hex.id);
      }
    });

    updates(hexagons);
  }

  /**
   * Apply starvation to hexes with no food
   */
  private applyStarvation(): number {
    const hexagons = this.db.prepare('SELECT * FROM hexagons WHERE food_stored_tons < 0.1').all() as Hexagon[];

    let totalDeaths = 0;

    const updateStmt = this.db.prepare('UPDATE hexagons SET population = ? WHERE id = ?');

    const updates = this.db.transaction((hexList: Hexagon[]) => {
      for (const hex of hexList) {
        const deaths = Math.floor(hex.population * 0.1); // 10% death rate
        const newPopulation = Math.max(0, hex.population - deaths);
        totalDeaths += deaths;
        updateStmt.run(newPopulation, hex.id);
      }
    });

    updates(hexagons);

    return totalDeaths;
  }

  /**
   * Update game state
   */
  private updateGameState(round: number, starvationDeaths: number, transitDeaths: number): GameState {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];

    const totalPopulation = hexagons.reduce((sum, h) => sum + h.population, 0);
    const totalFood = hexagons.reduce((sum, h) => sum + h.food_stored_tons, 0);

    const currentState = this.getGameState();
    const newDeaths = currentState.total_deaths + starvationDeaths + transitDeaths;
    const newStarvationDeaths = currentState.deaths_starvation + starvationDeaths;
    const newTransitDeaths = currentState.deaths_transit + transitDeaths;

    this.db.prepare(`
      UPDATE game_state SET
        current_round = ?,
        total_population = ?,
        total_food_tons = ?,
        total_deaths = ?,
        deaths_starvation = ?,
        deaths_transit = ?
      WHERE id = 1
    `).run(round, totalPopulation, totalFood, newDeaths, newStarvationDeaths, newTransitDeaths);

    return this.getGameState();
  }

  /**
   * Save history snapshot
   */
  private saveHistorySnapshot(round: number): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];

    const stmt = this.db.prepare(`
      INSERT INTO history (
        round, hex_id, population, food_stored_tons, water_availability,
        infrastructure_avg, violence_level, net_force
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((snapshots: HexSnapshot[]) => {
      for (const snap of snapshots) {
        stmt.run(
          snap.round,
          snap.hex_id,
          snap.population,
          snap.food_stored_tons,
          snap.water_availability,
          snap.infrastructure_avg,
          snap.violence_level,
          snap.net_force
        );
      }
    });

    const snapshots: HexSnapshot[] = hexagons.map((hex) => ({
      round,
      hex_id: hex.id,
      population: hex.population,
      food_stored_tons: hex.food_stored_tons,
      water_availability: hex.water_availability,
      infrastructure_avg: (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3,
      violence_level: hex.violence_level,
      net_force: hex.net_force,
    }));

    insertMany(snapshots);
  }

  /**
   * Log event
   */
  private logEvent(round: number, hexId: string | null, eventType: string, description: string, impactValue: number): void {
    this.db.prepare(`
      INSERT INTO events (round, hex_id, event_type, description, impact_value)
      VALUES (?, ?, ?, ?, ?)
    `).run(round, hexId, eventType, description, impactValue);
  }

  /**
   * Get current game state
   */
  getGameState(): GameState {
    return this.db.prepare('SELECT * FROM game_state WHERE id = 1').get() as GameState;
  }

  /**
   * Get hexagon by ID
   */
  getHexagon(id: string): Hexagon | undefined {
    return this.db.prepare('SELECT * FROM hexagons WHERE id = ?').get(id) as Hexagon | undefined;
  }

  /**
   * Get all hexagons
   */
  getAllHexagons(): Hexagon[] {
    return this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];
  }

  /**
   * Get recent events
   */
  getRecentEvents(limit: number = 10): EventLog[] {
    return this.db.prepare(`
      SELECT * FROM events ORDER BY round DESC, id DESC LIMIT ?
    `).all(limit) as EventLog[];
  }
}
