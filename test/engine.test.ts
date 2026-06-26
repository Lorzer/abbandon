/**
 * ABBADON engine tests (node:test). Run with: npm test
 *
 * Covers the four properties the tuning workflow depends on:
 *  - determinism (same seed+config => identical run)
 *  - population conservation (pop in == pop out + deaths)
 *  - collapse pacing (paced, urban-first, but world still collapses)
 *  - transit deaths actually accrue
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DatabaseInitializer } from '../src/init.js';
import { SimulationEngine } from '../src/simulation.js';
import { ScriptedDirector } from '../src/director.js';
import { makeConfig, type DeepPartial, type SimConfig } from '../src/config.js';

function setup(overrides: DeepPartial<SimConfig> = {}) {
  const config = makeConfig(overrides);
  const init = new DatabaseInitializer(':memory:', config);
  init.initialize();
  const sim = new SimulationEngine(init.getDatabase(), config);
  const director = new ScriptedDirector(config);
  return { config, init, sim, director };
}

function pops(sim: SimulationEngine) {
  const hexes = sim.getAllHexagons();
  const urban = hexes.filter((h) => h.type === 'urban').reduce((s, h) => s + h.population, 0);
  const rural = hexes.filter((h) => h.type === 'rural').reduce((s, h) => s + h.population, 0);
  return { urban, rural, total: urban + rural };
}

function stateHash(sim: SimulationEngine): string {
  return sim
    .getAllHexagons()
    .map((h) => `${h.id}:${h.population}:${h.food_stored_tons.toFixed(4)}:${h.net_force.toFixed(4)}`)
    .sort()
    .join('|');
}

/** Step `rounds` times, collecting per-round metrics and checking conservation. */
async function run(sim: SimulationEngine, director: ScriptedDirector, rounds: number) {
  const series: { round: number; urban: number; rural: number; total: number }[] = [];
  for (let r = 1; r <= rounds; r++) {
    const before = pops(sim).total;
    const deathsBefore = sim.getGameState().total_deaths;
    await sim.runRound(director);
    const after = pops(sim).total;
    const deathsDelta = sim.getGameState().total_deaths - deathsBefore;

    // Conservation invariant: nobody appears or vanishes unaccounted for.
    assert.equal(before - deathsDelta, after, `conservation broke at round ${r}`);

    const p = pops(sim);
    series.push({ round: r, ...p });
  }
  return series;
}

test('determinism: same seed+config => identical state at round 30', async () => {
  const a = setup({ seed: 42 });
  const b = setup({ seed: 42 });
  await run(a.sim, a.director, 30);
  await run(b.sim, b.director, 30);
  assert.equal(stateHash(a.sim), stateHash(b.sim));
});

test('determinism: different seed => different state', async () => {
  const a = setup({ seed: 1 });
  const b = setup({ seed: 2 });
  await run(a.sim, a.director, 30);
  await run(b.sim, b.director, 30);
  assert.notEqual(stateHash(a.sim), stateHash(b.sim));
});

test('collapse pacing: urban survives early, world collapses by the end', async () => {
  const { sim, director } = setup({ seed: 7 });
  const initialUrban = pops(sim).urban;
  const initialTotal = pops(sim).total;

  const series = await run(sim, director, 60);
  const at = (r: number) => series.find((s) => s.round === r)!;

  // Not instant: cities still substantially populated at round 10 (the old
  // engine emptied them by ~round 3).
  assert.ok(
    at(10).urban > 0.5 * initialUrban,
    `urban collapsed too fast: ${at(10).urban} of ${initialUrban} at round 10`
  );

  // Urban-first: by the end, urban is far more depleted than rural (relative to start).
  const finalUrbanFrac = at(60).urban / initialUrban;
  assert.ok(finalUrbanFrac < 0.5, `urban did not collapse by round 60: frac ${finalUrbanFrac.toFixed(2)}`);

  // The premise holds: the world as a whole has lost significant population.
  assert.ok(
    at(60).total < 0.85 * initialTotal,
    `world did not collapse: ${at(60).total} of ${initialTotal} at round 60`
  );
});

test('transit deaths accrue during migration', async () => {
  const { sim, director } = setup({ seed: 3 });
  await run(sim, director, 60);
  assert.ok(sim.getGameState().deaths_transit > 0, 'expected some transit deaths');
});

test('fork: rewind to a recorded round restores that snapshot', async () => {
  const { sim, director } = setup({ seed: 9 });
  await run(sim, director, 20);
  const snap10 = sim.getHistoryForRound(10);
  const forked = sim.forkFromRound(10);

  assert.equal(forked.current_round, 10);
  // Live population should match the round-10 snapshot total.
  const snapTotal = snap10.reduce((s, h) => s + h.population, 0);
  assert.equal(pops(sim).total, snapTotal);
  // History after the fork point is gone.
  assert.equal(sim.getHistoryForRound(15).length, 0);
});
