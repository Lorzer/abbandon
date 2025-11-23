/**
 * ABBADON Phase 1 - Database Initialization and World Creation
 */

import Database from 'better-sqlite3';
import type { Hexagon, GameState, Edge } from './types.js';

export class DatabaseInitializer {
  private db: Database.Database;

  constructor(dbPath: string = './abbadon.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  /**
   * Initialize the complete database schema
   */
  initializeDatabase(): void {
    this.db.exec(`
      -- Hexagons table: Current state of all 100 hexes
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

      -- Edges table: Connections between adjacent hexagons
      CREATE TABLE IF NOT EXISTS edges (
        from_hex_id TEXT NOT NULL,
        to_hex_id TEXT NOT NULL,
        base_permeability REAL NOT NULL,
        PRIMARY KEY (from_hex_id, to_hex_id),
        FOREIGN KEY (from_hex_id) REFERENCES hexagons(id),
        FOREIGN KEY (to_hex_id) REFERENCES hexagons(id)
      );

      -- Game state table: Global simulation state
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        current_round INTEGER NOT NULL,
        total_population INTEGER NOT NULL,
        total_food_tons REAL NOT NULL,
        total_deaths INTEGER NOT NULL,
        deaths_starvation INTEGER NOT NULL,
        deaths_transit INTEGER NOT NULL
      );

      -- History table: Snapshots for each round
      CREATE TABLE IF NOT EXISTS history (
        round INTEGER NOT NULL,
        hex_id TEXT NOT NULL,
        population INTEGER NOT NULL,
        food_stored_tons REAL NOT NULL,
        water_availability REAL NOT NULL,
        infrastructure_avg REAL NOT NULL,
        violence_level INTEGER NOT NULL,
        net_force REAL NOT NULL,
        PRIMARY KEY (round, hex_id)
      );

      -- Events table: Log of what happened each round
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round INTEGER NOT NULL,
        hex_id TEXT,
        event_type TEXT NOT NULL,
        description TEXT NOT NULL,
        impact_value REAL NOT NULL
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_hexagons_type ON hexagons(type);
      CREATE INDEX IF NOT EXISTS idx_history_round ON history(round);
      CREATE INDEX IF NOT EXISTS idx_events_round ON events(round);
      CREATE INDEX IF NOT EXISTS idx_hexagons_grid ON hexagons(grid_x, grid_y);
    `);

    console.log('✓ Database schema initialized');
  }

  /**
   * Create initial 100 hexagons
   * - First 20: Urban (40k people each)
   * - Last 80: Rural (2.5k people each)
   */
  createInitialHexagons(): void {
    const stmt = this.db.prepare(`
      INSERT INTO hexagons (
        id, type, area_km2, population, food_stored_tons, food_production_per_month,
        water_availability, infrastructure_power, infrastructure_water, infrastructure_roads,
        violence_level, cohesion, farmland_pct, grid_x, grid_y
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((hexagons: any[]) => {
      for (const hex of hexagons) {
        stmt.run(
          hex.id,
          hex.type,
          hex.area_km2,
          hex.population,
          hex.food_stored_tons,
          hex.food_production_per_month,
          hex.water_availability,
          hex.infrastructure_power,
          hex.infrastructure_water,
          hex.infrastructure_roads,
          hex.violence_level,
          hex.cohesion,
          hex.farmland_pct,
          hex.grid_x,
          hex.grid_y
        );
      }
    });

    const hexagons: Partial<Hexagon>[] = [];
    const gridSize = 10;

    for (let i = 0; i < 100; i++) {
      const hexId = `HEX_${String(i).padStart(3, '0')}`;
      const isUrban = i < 20;
      const gridX = i % gridSize;
      const gridY = Math.floor(i / gridSize);

      const hex: Partial<Hexagon> = {
        id: hexId,
        type: isUrban ? 'urban' : 'rural',
        area_km2: isUrban ? 10 : 50,
        population: isUrban ? 40000 : 2500,
        food_stored_tons: isUrban ? 200 : 50,
        food_production_per_month: isUrban ? 0 : 25,
        water_availability: 90 + Math.random() * 10, // 90-100%
        infrastructure_power: 85 + Math.random() * 5, // 85-90%
        infrastructure_water: 85 + Math.random() * 5,
        infrastructure_roads: 85 + Math.random() * 5,
        violence_level: 5, // Very low
        cohesion: 75 + Math.random() * 10, // 75-85%
        farmland_pct: isUrban ? 0 : 60 + Math.random() * 20, // Rural: 60-80%
        grid_x: gridX,
        grid_y: gridY,
      };

      hexagons.push(hex);
    }

    insertMany(hexagons);
    console.log('✓ Created 100 hexagons (20 urban, 80 rural)');
  }

  /**
   * Create edges between adjacent hexagons
   * 4-directional: up, down, left, right
   */
  createEdges(): void {
    const stmt = this.db.prepare(`
      INSERT INTO edges (from_hex_id, to_hex_id, base_permeability)
      VALUES (?, ?, ?)
    `);

    const insertMany = this.db.transaction((edges: Edge[]) => {
      for (const edge of edges) {
        stmt.run(edge.from_hex_id, edge.to_hex_id, edge.base_permeability);
      }
    });

    const edges: Edge[] = [];
    const gridSize = 10;

    for (let i = 0; i < 100; i++) {
      const hexId = `HEX_${String(i).padStart(3, '0')}`;
      const x = i % gridSize;
      const y = Math.floor(i / gridSize);

      // Helper to add bidirectional edge
      const addEdge = (neighborX: number, neighborY: number) => {
        if (neighborX >= 0 && neighborX < gridSize && neighborY >= 0 && neighborY < gridSize) {
          const neighborIdx = neighborY * gridSize + neighborX;
          const neighborId = `HEX_${String(neighborIdx).padStart(3, '0')}`;
          const permeability = 0.8 + Math.random() * 0.2; // 0.8-1.0

          edges.push({
            from_hex_id: hexId,
            to_hex_id: neighborId,
            base_permeability: permeability,
          });
        }
      };

      // Create edges to: right, left, down, up
      addEdge(x + 1, y); // Right
      addEdge(x - 1, y); // Left
      addEdge(x, y + 1); // Down
      addEdge(x, y - 1); // Up
    }

    insertMany(edges);
    console.log(`✓ Created ${edges.length} edges`);
  }

  /**
   * Initialize game state at round 0
   */
  initializeGameState(): void {
    const hexagons = this.db.prepare('SELECT * FROM hexagons').all() as Hexagon[];

    const totalPopulation = hexagons.reduce((sum, h) => sum + h.population, 0);
    const totalFood = hexagons.reduce((sum, h) => sum + h.food_stored_tons, 0);

    this.db.prepare(`
      INSERT INTO game_state (
        id, current_round, total_population, total_food_tons,
        total_deaths, deaths_starvation, deaths_transit
      ) VALUES (1, 0, ?, ?, 0, 0, 0)
    `).run(totalPopulation, totalFood);

    console.log(`✓ Game state initialized: ${totalPopulation.toLocaleString()} people, ${totalFood.toFixed(0)} tons food`);
  }

  /**
   * Complete initialization: create schema + world
   */
  initialize(): void {
    console.log('Initializing ABBADON Phase 1 database...\n');

    this.initializeDatabase();
    this.createInitialHexagons();
    this.createEdges();
    this.initializeGameState();

    console.log('\n✓ Database initialization complete!');
  }

  /**
   * Reset database (delete and recreate)
   */
  reset(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS history;
      DROP TABLE IF EXISTS game_state;
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS hexagons;
    `);
    console.log('✓ Database reset');
  }

  close(): void {
    this.db.close();
  }
}
