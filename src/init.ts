/**
 * ABBADON - World Generation
 *
 * Builds the initial in-memory WorldState from SimConfig + a seeded RNG. A given
 * (seed, config) pair always produces the same starting world. No database — the
 * engine runs on plain objects; persistence is handled separately (Supabase).
 */

import type { Hexagon, Edge, GameState, WorldState } from './types.js';
import type { SimConfig, HexTemplate } from './config.js';
import { RNG } from './rng.js';

/**
 * The 6 neighbours of a hex in "odd-r" offset coordinates (pointy-top layout,
 * odd rows shifted right). Returns offsets that may be off-grid; callers clamp.
 */
export function hexNeighbors(col: number, row: number): [number, number][] {
  const odd = row % 2 !== 0;
  return odd
    ? [
        [col + 1, row], // E
        [col - 1, row], // W
        [col, row - 1], // NW
        [col + 1, row - 1], // NE
        [col, row + 1], // SW
        [col + 1, row + 1], // SE
      ]
    : [
        [col + 1, row], // E
        [col - 1, row], // W
        [col - 1, row - 1], // NW
        [col, row - 1], // NE
        [col - 1, row + 1], // SW
        [col, row + 1], // SE
      ];
}

let runCounter = 0;
export function makeRunId(seed: number): string {
  // Unique per run so history from previous runs survives a reset. Wall clock +
  // a counter only disambiguates ids; never used for simulation math.
  return `run-${seed}-${Date.now()}-${runCounter++}`;
}

function buildHexagons(config: SimConfig, rng: RNG): Hexagon[] {
  const { gridSize, urbanCount, urban, rural } = config.world;
  const count = gridSize * gridSize;
  const hexagons: Hexagon[] = [];

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
      attractor_force: 0,
      repulsor_force: 0,
      net_force: 0,
      grid_x: i % gridSize,
      grid_y: Math.floor(i / gridSize),
    });
  }
  return hexagons;
}

function buildEdges(config: SimConfig, rng: RNG): Edge[] {
  const { gridSize, permeability } = config.world;
  const count = gridSize * gridSize;
  const edges: Edge[] = [];

  for (let i = 0; i < count; i++) {
    const x = i % gridSize;
    const y = Math.floor(i / gridSize);
    for (const [nx, ny] of hexNeighbors(x, y)) {
      if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
      edges.push({
        from_hex_id: `HEX_${String(i).padStart(3, '0')}`,
        to_hex_id: `HEX_${String(ny * gridSize + nx).padStart(3, '0')}`,
        base_permeability: rng.range(permeability[0], permeability[1]),
      });
    }
  }
  return edges;
}

/**
 * Create a fresh world (round 0) deterministically from config.
 */
export function createWorld(config: SimConfig): WorldState {
  const hexagons = buildHexagons(config, new RNG(config.seed));
  const edges = buildEdges(config, new RNG(config.seed ^ 0x55aa55aa));

  const totalPopulation = hexagons.reduce((sum, h) => sum + h.population, 0);
  const totalFood = hexagons.reduce((sum, h) => sum + h.food_stored_tons, 0);

  const gameState: GameState = {
    id: 1,
    run_id: makeRunId(config.seed),
    current_round: 0,
    total_population: totalPopulation,
    total_food_tons: totalFood,
    total_deaths: 0,
    deaths_starvation: 0,
    deaths_transit: 0,
  };

  return { config, gameState, hexagons, edges, history: [], events: [] };
}
