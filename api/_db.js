/**
 * ABBADON - Supabase persistence (Postgres is the only database).
 *
 * The engine (compiled to ../dist) runs purely in memory on a WorldState.
 * These helpers load a WorldState from the colla_* tables and write it back.
 */

import { createClient } from '@supabase/supabase-js';
import { createWorld } from '../dist/init.js';
import { ScriptedDirector, GemmaDirector } from '../dist/director.js';
import { DEFAULT_CONFIG, applyConfig, requiresReinit } from '../dist/config.js';

const HEX_COLS = [
  'id', 'type', 'area_km2', 'population', 'food_stored_tons', 'food_production_per_month',
  'water_availability', 'infrastructure_power', 'infrastructure_water', 'infrastructure_roads',
  'violence_level', 'cohesion', 'farmland_pct', 'attractor_force', 'repulsor_force', 'net_force',
  'grid_x', 'grid_y',
];

let _sb = null;
export function sb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

export function makeDirector(config) {
  // Opt-in LLM: Gemma 4 via the colla_gemma edge function when enabled and
  // Supabase creds are present; otherwise the deterministic scripted director.
  if (config.useLLM && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new GemmaDirector(config);
  }
  return new ScriptedDirector(config);
}

async function currentRunId() {
  const { data, error } = await sb().from('colla_meta').select('value').eq('key', 'current_run_id').maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}
async function setCurrentRunId(runId) {
  const { error } = await sb().from('colla_meta').upsert({ key: 'current_run_id', value: runId });
  if (error) throw error;
}

function hexRow(runId, h) {
  const row = { run_id: runId };
  for (const c of HEX_COLS) row[c] = h[c];
  return row;
}

/** Write game_state row (without touching config when not provided). */
async function writeGameState(state) {
  const gs = state.gameState;
  const { error } = await sb().from('colla_game_state').upsert({
    run_id: gs.run_id,
    current_round: gs.current_round,
    total_population: gs.total_population,
    total_food_tons: gs.total_food_tons,
    total_deaths: gs.total_deaths,
    deaths_starvation: gs.deaths_starvation,
    deaths_transit: gs.deaths_transit,
    config: state.config,
  });
  if (error) throw error;
}

/** Create a brand-new run, persist it, and point current_run_id at it. */
export async function createNewRun(config) {
  const state = createWorld(config);
  const runId = state.gameState.run_id;

  let r = await sb().from('colla_hexagons').insert(state.hexagons.map((h) => hexRow(runId, h)));
  if (r.error) throw r.error;
  r = await sb().from('colla_edges').insert(
    state.edges.map((e) => ({ run_id: runId, from_hex_id: e.from_hex_id, to_hex_id: e.to_hex_id, base_permeability: e.base_permeability }))
  );
  if (r.error) throw r.error;
  await writeGameState(state);
  await setCurrentRunId(runId);
  return state;
}

/** Load the current run as a WorldState (creating a default run if none). */
export async function loadWorld(opts = {}) {
  let runId = await currentRunId();
  if (!runId) return createNewRun(DEFAULT_CONFIG);

  const gsRes = await sb().from('colla_game_state').select('*').eq('run_id', runId).maybeSingle();
  if (gsRes.error) throw gsRes.error;
  if (!gsRes.data) return createNewRun(DEFAULT_CONFIG);
  const row = gsRes.data;

  const [hexRes, edgeRes] = await Promise.all([
    sb().from('colla_hexagons').select('*').eq('run_id', runId),
    sb().from('colla_edges').select('*').eq('run_id', runId),
  ]);
  if (hexRes.error) throw hexRes.error;
  if (edgeRes.error) throw edgeRes.error;

  let history = [];
  if (opts.withHistory) {
    const h = await sb().from('colla_history').select('*').eq('run_id', runId);
    if (h.error) throw h.error;
    history = h.data ?? [];
  }

  return {
    config: row.config,
    gameState: {
      id: 1,
      run_id: runId,
      current_round: row.current_round,
      total_population: Number(row.total_population),
      total_food_tons: row.total_food_tons,
      total_deaths: Number(row.total_deaths),
      deaths_starvation: Number(row.deaths_starvation),
      deaths_transit: Number(row.deaths_transit),
    },
    hexagons: hexRes.data ?? [],
    edges: edgeRes.data ?? [],
    history,
    events: [],
  };
}

/** Persist after a single step: game_state, hexagons, and the round's history + events. */
export async function saveStep(state) {
  const runId = state.gameState.run_id;
  await writeGameState(state);

  let r = await sb().from('colla_hexagons').upsert(state.hexagons.map((h) => hexRow(runId, h)), { onConflict: 'run_id,id' });
  if (r.error) throw r.error;

  if (state.history.length) {
    r = await sb().from('colla_history').upsert(
      state.history.map((s) => ({ run_id: runId, ...s })),
      { onConflict: 'run_id,round,hex_id' }
    );
    if (r.error) throw r.error;
  }
  if (state.events.length) {
    r = await sb().from('colla_events').insert(state.events.map((e) => ({ run_id: runId, ...e })));
    if (r.error) throw r.error;
  }
}

/** Persist after a fork: restored hexagons + game_state, and drop history/events past the fork point. */
export async function saveFork(state, round) {
  const runId = state.gameState.run_id;
  await writeGameState(state);
  let r = await sb().from('colla_hexagons').upsert(state.hexagons.map((h) => hexRow(runId, h)), { onConflict: 'run_id,id' });
  if (r.error) throw r.error;
  await sb().from('colla_history').delete().eq('run_id', runId).gt('round', round);
  await sb().from('colla_events').delete().eq('run_id', runId).gt('round', round);
}

export async function currentConfig() {
  const runId = await currentRunId();
  if (!runId) return DEFAULT_CONFIG;
  const { data, error } = await sb().from('colla_game_state').select('config').eq('run_id', runId).maybeSingle();
  if (error) throw error;
  return data?.config ?? DEFAULT_CONFIG;
}

/** Apply a config override. World-gen changes regenerate the world; others are live. */
export async function applyConfigChange(overrides) {
  const next = applyConfig(await currentConfig(), overrides);
  const runId = await currentRunId();
  if (requiresReinit(overrides) || !runId) {
    const state = await createNewRun(next);
    return { reinit: true, state };
  }
  const { error } = await sb().from('colla_game_state').update({ config: next }).eq('run_id', runId);
  if (error) throw error;
  return { reinit: false, state: null, config: next };
}

export async function recentEvents(runId, limit = 10) {
  const { data, error } = await sb()
    .from('colla_events')
    .select('round, hex_id, event_type, description, impact_value')
    .eq('run_id', runId)
    .order('round', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function historyForRound(round) {
  const runId = await currentRunId();
  if (!runId) return [];
  const { data, error } = await sb()
    .from('colla_history')
    .select('*')
    .eq('run_id', runId)
    .eq('round', round)
    .order('hex_id');
  if (error) throw error;
  return data ?? [];
}

export async function listRuns() {
  const { data, error } = await sb()
    .from('colla_game_state')
    .select('run_id, current_round, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return { runs: data ?? [], currentRunId: await currentRunId() };
}

/** Standard response payload (gameState + hexagons + recent events + config). */
export async function payload(state) {
  return {
    gameState: state.gameState,
    hexagons: state.hexagons,
    events: await recentEvents(state.gameState.run_id),
    config: state.config,
  };
}
