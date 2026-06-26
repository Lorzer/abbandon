/**
 * ABBADON - Database Initialization and World Creation
 *
 * The world is generated entirely from SimConfig + a seeded RNG, so a given
 * (seed, config) pair always produces the same starting world.
 */

import Database from 'better-sqlite3';
import type { Hexagon, GameState, Edge } from './types.js';
import type { SimConfig, HexTemplate } from './config.js';
import { RNG } from './rng.js';

export class DatabaseInitializer {
  private db: Database.Database;
  private config: SimConfig;
  private runId: string;
  private runCounter = 0;

  constructor(dbPath: string = './abbadon.db', config: SimConfig) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.config = config;
    this.runId = this.makeRunId();
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  getRunId(): string {
    return this.runId;
  }

  setConfig(config: SimConfig): void {
    this.config = config;
  }

  private makeRunId(): string {
    // Unique per run so history from previous runs survives a reset. Wall clock
    // + a monotonic counter is only used to disambiguate ids, never for math.
    return `run-${this.config.seed}-${Date.now()}-${this.runCounter++}`;
  }

  /**
   * Initialize the complete database schema.
   */
  initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hexagons (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('urban', 'rural')),
        area_km2 REAL NOT NULL,
        population INTEGER NOT NULL,
        food_stored_tons REAL NOT NULL,
        food_production_per_month REAL NOT NULL,
        water_availability REAL NOT NULL,
        infrastructure_power REAL NOT NULL,
        infrastructure_water REAL NOT NULL,
        infrastructure_roads REAL NOT NULL,
        violence_level INTEGER NOT NULL,
        cohesion REAL NOT NULL,
        farmland_pct REAL NOT NULL,
        attractor_force REAL NOT NULL DEFAULT 0,
        repulsor_force REAL NOT NULL DEFAULT 0,
        net_force REAL NOT NULL DEFAULT 0,
        grid_x INTEGER NOT NULL,
        grid_y INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        from_hex_id TEXT NOT NULL,
        to_hex_id TEXT NOT NULL,
        base_permeability REAL NOT NULL,
        PRIMARY KEY (from_hex_id, to_hex_id),
        FOREIGN KEY (from_hex_id) REFERENCES hexagons(id),
        FOREIGN KEY (to_hex_id) REFERENCES hexagons(id)
      );

      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        run_id TEXT NOT NULL,
        current_round INTEGER NOT NULL,
        total_population INTEGER NOT NULL,
        total_food_tons REAL NOT NULL,
        total_deaths INTEGER NOT NULL,
        deaths_starvation INTEGER NOT NULL,
        deaths_transit INTEGER NOT NULL
      );

      -- History snapshots, namespaced by run_id so past runs survive a reset.
      CREATE TABLE IF NOT EXISTS history (
        run_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        hex_id TEXT NOT NULL,
        population INTEGER NOT NULL,
        food_stored_tons REAL NOT NULL,
        water_availability REAL NOT NULL,
        infrastructure_avg REAL NOT NULL,
        violence_level INTEGER NOT NULL,
        net_force REAL NOT NULL,
        PRIMARY KEY (run_id, round, hex_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round INTEGER NOT NULL,
        hex_id TEXT,
        event_type TEXT NOT NULL,
        description TEXT NOT NULL,
        impact_value REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hexagons_type ON hexagons(type);
      CREATE INDEX IF NOT EXISTS idx_history_run_round ON history(run_id, round);
      CREATE INDEX IF NOT EXISTS idx_events_round ON events(round);
      CREATE INDEX IF NOT EXISTS idx_hexagons_grid ON hexagons(grid_x, grid_y);
    `);
  }

  /**
   * Create the initial hexagons from config (first `urbanCount` are urban).
   */
  createInitialHexagons(): void {
    const rng = new RNG(this.config.seed);
    const { gridSize, urbanCount, urban, rural } = this.config.world;
    const count = gridSize * gridSize;

    const stmt = this.db.prepare(`
      INSERT INTO hexagons (
        id, type, area_km2, population, food_stored_tons, food_production_per_month,
        water_availability, infrastructure_power, infrastructure_water, infrastructure_roads,
        violence_level, cohesion, farmland_pct, grid_x, grid_y
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((hexagons: any[]) => {
      for (const h of hexagons) {
        stmt.run(
          h.id, h.type, h.area_km2, h.population, h.food_stored_tons, h.food_production_per_month,
          h.water_availability, h.infrastructure_power, h.infrastructure_water, h.infrastructure_roads,
          h.violence_level, h.cohesion, h.farmland_pct, h.grid_x, h.grid_y
        );
      }
    });

    const hexagons: Partial<Hexagon>[] = [];
    for (let i = 0; i < count; i++) {
      const isUrban = i < urbanCount;
      const t: HexTemplate = isUrban ? urban : rural;
      hexagons.push({
        id: `HEX_${String(i).padStart(3, '0')}`,
        type: isUrban ? 'urban' : 'rural',
        area_km2: t.areaKm2,
        population: t.population,
        food_stored_tons: t.foodStoredTons,
        food_production_per_month: t.foodProductionPerMonth,
        water_availability: rng.range(t.waterAvailability[0], t.waterAvailability[1]),
        infrastructure_power: rng.range(t.infrastructure[0], t.infrastructure[1]),
        infrastructure_water: rng.range(t.infrastructure[0], t.infrastructure[1]),
        infrastructure_roads: rng.range(t.infrastructure[0], t.infrastructure[1]),
        violence_level: t.violenceLevel,
        cohesion: rng.range(t.cohesion[0], t.cohesion[1]),
        farmland_pct: rng.range(t.farmlandPct[0], t.farmlandPct[1]),
        grid_x: i % gridSize,
        grid_y: Math.floor(i / gridSize),
      });
    }

    insertMany(hexagons);
  }

  /**
   * Create 4-directional edges between adjacent hexagons.
   */
  createEdges(): void {
    const rng = new RNG(this.config.seed ^ 0x55aa55aa);
    const { gridSize, permeability } = this.config.world;
    const count = gridSize * gridSize;

    const stmt = this.db.prepare(
      `INSERT INTO edges (from_hex_id, to_hex_id, base_permeability) VALUES (?, ?, ?)`
    );
    const insertMany = this.db.transaction((edges: Edge[]) => {
      for (const e of edges) stmt.run(e.from_hex_id, e.to_hex_id, e.base_permeability);
    });

    const edges: Edge[] = [];
    for (let i = 0; i < count; i++) {
      const x = i % gridSize;
      const y = Math.floor(i / gridSize);
      const addEdge = (nx: number, ny: number) => {
        if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) return;
        edges.push({
          from_hex_id: `HEX_${String(i).padStart(3, '0')}`,
          to_hex_id: `HEX_${String(ny * gridSize + nx).padStart(3, '0')}`,
          base_permeability: rng.range(permeability[0], permeability[1]),
        });
      };
      addEdge(x + 1, y);
      addEdge(x - 1, y);
      addEdge(x, y + 1);
      addEdge(x, y - 1);
    }

    insertMany(edges);
  }

  /**
   * Initialize game state at round 0.
   */
  initializeGameState(): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];
    const totalPopulation = hexagons.reduce((sum, h) => sum + h.population, 0);
    const totalFood = hexagons.reduce((sum, h) => sum + h.food_stored_tons, 0);

    this.db
      .prepare(
        `INSERT INTO game_state (
          id, run_id, current_round, total_population, total_food_tons,
          total_deaths, deaths_starvation, deaths_transit
        ) VALUES (1, ?, 0, ?, ?, 0, 0, 0)`
      )
      .run(this.runId, totalPopulation, totalFood);
  }

  /**
   * Complete initialization: schema + world.
   */
  initialize(): void {
    this.initializeDatabase();
    this.createInitialHexagons();
    this.createEdges();
    this.initializeGameState();
    console.log(`✓ World initialized (run ${this.runId})`);
  }

  /**
   * Reset for a new run: clear the live world but KEEP history (namespaced by
   * run_id) so prior runs can still be inspected. A fresh run_id is assigned.
   */
  reset(): void {
    this.db.exec(`
      DELETE FROM events;
      DROP TABLE IF EXISTS game_state;
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS hexagons;
    `);
    this.runId = this.makeRunId();
  }

  close(): void {
    this.db.close();
  }
}
