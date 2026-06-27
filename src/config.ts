/**
 * ABBADON - Simulation Configuration
 *
 * Every tunable factor in the engine lives here so the simulation can be
 * "played with" without editing engine code. DEFAULT_CONFIG is the baseline;
 * the UI (and tests) override fields on top of it.
 *
 * IMPORTANT framing: collapse is the *premise*, not a failure state. These
 * knobs shape the PACE and SPATIAL TEXTURE of an inevitable collapse
 * (urban-first, gradual, uneven) - they are not meant to make the world
 * survivable long-term.
 */

export interface SimConfig {
  /** Seed for all stochastic world generation. Same seed + same config => identical run. */
  seed: number;

  /** When false, a deterministic ScriptedDirector drives weather (no network, reproducible). */
  useLLM: boolean;

  /** LLM director settings (Gemma 4 via the colla_gemma Supabase edge function). */
  llm: {
    model: string;
    thinkingLevel: 'low' | 'medium' | 'high';
  };

  /** Total rounds in a run (months). 60 = 5 years. */
  totalRounds: number;

  /** World generation - changing any of these requires a fresh world (re-init). */
  world: {
    gridSize: number; // NxN grid
    urbanCount: number; // first N hexes are urban
    urban: HexTemplate;
    rural: HexTemplate;
    /** Base edge permeability range [min, max], sampled per edge. */
    permeability: [number, number];
  };

  /** Food consumed per person per month, in tons (2 kg = 0.002 t). */
  consumption: {
    perCapitaTonsPerMonth: number;
  };

  production: {
    /** People required before a rural hex farms at full labor capacity. */
    farmersNeeded: number;
    /**
     * Urban "supply line" imports (tons/month/hex) that decay each round as the
     * outside world fails. This is what gives cities a survivable window before
     * they collapse, instead of starving in ~3 rounds.
     */
    urbanBaselineSupplyTons: number;
    urbanBaselineSupplyDecay: number; // per-round multiplier, e.g. 0.9
  };

  /**
   * Force model. Each term is computed as a normalized 0-100 intensity, then
   * multiplied by its weight. net = Σ(attractor weights·intensity)
   *                                - Σ(repulsor weights·intensity)
   *                                + security (signed). Tune the weights to
   * shape how fast/unevenly the world tips into collapse.
   */
  forces: {
    foodSurplus: { weight: number; thresholdMonths: number; spanMonths: number };
    waterAttract: { weight: number };
    infraAttract: { weight: number };
    /** Single signed term replacing the old safety/violence double-count. */
    security: { weight: number; neutralViolence: number; maxViolence: number };
    foodShortage: { weight: number; thresholdMonths: number };
    waterShortage: { weight: number; thresholdPct: number };
    overcrowding: { weight: number };
    infraCollapse: { weight: number; thresholdPct: number };
  };

  migration: {
    /** Hex must be at least this repelled (net force) before anyone leaves. */
    leaveNetThreshold: number; // e.g. -20
    /** Max fraction of a hex that can leave in one round. */
    maxLeavePct: number; // e.g. 0.2
    /** |net| / leaveScale = leave fraction (capped by maxLeavePct). */
    leaveScale: number; // e.g. 500
    /**
     * Fraction of migrants who die in transit at zero road quality; scaled down
     * by road condition. Feeds deaths_transit. Rises as infrastructure collapses.
     */
    transitMortality: number; // e.g. 0.1
  };

  decay: {
    /** Base infrastructure decay %/month (multiplied by the director's multiplier). */
    baseInfraPct: number; // e.g. 0.5
  };

  starvation: {
    /** A hex with less than this much food (tons) loses population. */
    foodThresholdTons: number; // e.g. 0.1
    /** Fraction of population that dies per round when starving. */
    deathRate: number; // e.g. 0.1
  };
}

export interface HexTemplate {
  areaKm2: number;
  population: number;
  foodStoredTons: number;
  foodProductionPerMonth: number;
  /** Sampled ranges [min, max] at world-gen. */
  waterAvailability: [number, number];
  infrastructure: [number, number]; // applied to power/water/roads independently
  violenceLevel: number;
  cohesion: [number, number];
  farmlandPct: [number, number];
  /** Density (people/km²) above which overcrowding repulsion begins. */
  overcrowdingDensity: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  useLLM: false,
  llm: {
    model: 'gemma-4-31b-it',
    thinkingLevel: 'high',
  },
  totalRounds: 60,

  world: {
    gridSize: 10,
    urbanCount: 20,
    urban: {
      areaKm2: 10,
      population: 40000,
      // Raised from 200 -> 600 (7.5 months) so cities die over rounds, not instantly.
      foodStoredTons: 600,
      foodProductionPerMonth: 0,
      waterAvailability: [90, 100],
      infrastructure: [85, 90],
      violenceLevel: 1, // was 5 ("very low") which was actually mid-scale; start genuinely low.
      cohesion: [75, 85],
      farmlandPct: [0, 0],
      overcrowdingDensity: 5000,
    },
    rural: {
      areaKm2: 50,
      population: 2500,
      foodStoredTons: 50,
      foodProductionPerMonth: 25,
      waterAvailability: [90, 100],
      infrastructure: [85, 90],
      violenceLevel: 1,
      cohesion: [75, 85],
      farmlandPct: [60, 80],
      overcrowdingDensity: 100,
    },
    permeability: [0.8, 1.0],
  },

  consumption: {
    perCapitaTonsPerMonth: 0.002,
  },

  production: {
    farmersNeeded: 100,
    urbanBaselineSupplyTons: 40,
    urbanBaselineSupplyDecay: 0.9,
  },

  forces: {
    foodSurplus: { weight: 0.5, thresholdMonths: 3, spanMonths: 5 },
    waterAttract: { weight: 0.5 },
    infraAttract: { weight: 0.5 },
    security: { weight: 0.6, neutralViolence: 5, maxViolence: 10 },
    foodShortage: { weight: 1.0, thresholdMonths: 1 },
    waterShortage: { weight: 1.0, thresholdPct: 50 },
    overcrowding: { weight: 0.5 },
    infraCollapse: { weight: 0.9, thresholdPct: 30 },
  },

  migration: {
    leaveNetThreshold: -20,
    maxLeavePct: 0.2,
    leaveScale: 500,
    transitMortality: 0.1,
  },

  decay: {
    baseInfraPct: 0.5,
  },

  starvation: {
    foodThresholdTons: 0.1,
    deathRate: 0.1,
  },
};

/** Top-level keys that, when changed, require regenerating the world. */
export const WORLD_REINIT_KEYS: (keyof SimConfig)[] = ['seed', 'world'];

/** Deep-merge a partial override onto DEFAULT_CONFIG (one level into nested groups). */
export function makeConfig(overrides: DeepPartial<SimConfig> = {}): SimConfig {
  return mergeDeep(structuredClone(DEFAULT_CONFIG), overrides) as SimConfig;
}

/** Deep-merge overrides onto an existing config, returning a new object. */
export function applyConfig(base: SimConfig, overrides: DeepPartial<SimConfig>): SimConfig {
  return mergeDeep(structuredClone(base), overrides) as SimConfig;
}

/** Whether a partial override touches any world-generation field (needs re-init). */
export function requiresReinit(overrides: DeepPartial<SimConfig>): boolean {
  return WORLD_REINIT_KEYS.some((k) => k in overrides);
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeDeep(target: any, source: any): any {
  if (!isPlainObject(source)) return target;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (isPlainObject(sv) && isPlainObject(target[key])) {
      mergeDeep(target[key], sv);
    } else if (sv !== undefined) {
      target[key] = sv;
    }
  }
  return target;
}
