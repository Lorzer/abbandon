/**
 * ABBADON - Seeded pseudo-random number generator (mulberry32).
 *
 * Replaces bare Math.random() so that, given the same seed + config, a run is
 * fully reproducible. Essential for tuning: you can change one factor and know
 * any difference came from the factor, not the dice.
 */
export class RNG {
  private state: number;

  constructor(seed: number) {
    // Avoid a zero state, which mulberry32 handles poorly.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}
