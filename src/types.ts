/**
 * ABBADON Phase 1 - Type Definitions
 */

export interface Hexagon {
  id: string;
  type: 'urban' | 'rural';
  area_km2: number;

  // Population
  population: number;

  // Resources
  food_stored_tons: number;
  food_production_per_month: number;
  water_availability: number; // 0-100%

  // Infrastructure
  infrastructure_power: number; // 0-100%
  infrastructure_water: number; // 0-100%
  infrastructure_roads: number; // 0-100%

  // Social
  violence_level: number; // 0-10 scale
  cohesion: number; // 0-100%

  // Production capacity
  farmland_pct: number; // 0-100%

  // Forces
  attractor_force: number;
  repulsor_force: number;
  net_force: number;

  // Grid position
  grid_x: number;
  grid_y: number;
}

export interface GameState {
  id: number;
  current_round: number;
  total_population: number;
  total_food_tons: number;
  total_deaths: number;
  deaths_starvation: number;
  deaths_transit: number;
}

export interface LLMDecision {
  weather: string;
  weather_severity: number; // 1-10
  weather_effects: {
    water_impact: number; // Percentage change
    food_impact: number; // Percentage change
    infrastructure_impact: number; // Percentage change
  };
  triggered_events: TriggeredEvent[];
  infrastructure_decay_multiplier: number; // 1.0 = normal, 2.0 = double decay
  narrative: string;
}

export interface TriggeredEvent {
  hex_id: string;
  event_type: 'violence' | 'disease' | 'infrastructure_collapse' | 'resource_discovery';
  severity: number; // 1-10
  reason: string;
}

export interface Forces {
  attractors: {
    food_surplus: number;
    water_availability: number;
    infrastructure_quality: number;
    safety: number;
  };
  repulsors: {
    food_shortage: number;
    water_shortage: number;
    violence: number;
    overcrowding: number;
    infrastructure_collapse: number;
  };
  net: number;
}

export interface PopulationFlow {
  from_hex_id: string;
  to_hex_id: string;
  population_count: number;
  permeability: number; // 0-1, how easy the move is
}

export interface Edge {
  from_hex_id: string;
  to_hex_id: string;
  base_permeability: number; // 0-1
}

export interface HexSnapshot {
  round: number;
  hex_id: string;
  population: number;
  food_stored_tons: number;
  water_availability: number;
  infrastructure_avg: number;
  violence_level: number;
  net_force: number;
}

export interface EventLog {
  round: number;
  hex_id: string | null;
  event_type: string;
  description: string;
  impact_value: number;
}

export interface HexChange {
  hex_id: string;
  population_change?: number;
  food_change?: number;
  water_change?: number;
  power_change?: number;
  violence_change?: number;
  current_state: {
    population: number;
    food: number;
    water: number;
    power: number;
    violence: number;
  };
}
