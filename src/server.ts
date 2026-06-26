/**
 * ABBADON - Express Server + WebSocket
 */

import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { DatabaseInitializer } from './init.js';
import { SimulationEngine } from './simulation.js';
import { LLMDirector } from './llm.js';
import { ScriptedDirector, type Director } from './director.js';
import { DEFAULT_CONFIG, applyConfig, requiresReinit, type SimConfig, type DeepPartial } from './config.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

let config: SimConfig = { ...DEFAULT_CONFIG };
let dbInitializer: DatabaseInitializer;
let simulation: SimulationEngine;
let director: Director;
let isPlaying = false;
let playInterval: NodeJS.Timeout | null = null;
/** Re-entrancy guard: only one round may be in flight at a time. */
let roundInFlight = false;

app.use(express.json());
app.use(express.static('public'));

function makeDirector(cfg: SimConfig): Director {
  if (cfg.useLLM && process.env.GOOGLE_API_KEY) {
    return new LLMDirector(process.env.GOOGLE_API_KEY);
  }
  if (cfg.useLLM) {
    console.warn('⚠ useLLM is set but GOOGLE_API_KEY is missing - falling back to ScriptedDirector.');
  }
  return new ScriptedDirector(cfg);
}

async function initializeApp() {
  console.log('\n🌍 ABBADON - Initializing...\n');

  dbInitializer = new DatabaseInitializer('./abbadon.db', config);
  const db = dbInitializer.getDatabase();

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='game_state'").all();
  if (tables.length === 0) {
    dbInitializer.initialize();
  } else {
    console.log('✓ Database already initialized');
  }

  simulation = new SimulationEngine(db, config);
  director = makeDirector(config);
  await director.initialize();

  console.log(`\n✓ Server ready (director: ${config.useLLM ? 'LLM' : 'Scripted'})\n`);
}

/**
 * Run exactly one round, guarded so a slow (async) round can't overlap with the
 * next play tick or a concurrent /api/step.
 */
async function runOneRound(): Promise<GameStateResult> {
  if (roundInFlight) return { status: 'busy' };
  const state = simulation.getGameState();
  if (state.current_round >= config.totalRounds) return { status: 'complete', gameState: state };

  roundInFlight = true;
  try {
    const gameState = await simulation.runRound(director);
    return { status: 'ok', gameState };
  } finally {
    roundInFlight = false;
  }
}

type GameStateResult =
  | { status: 'ok'; gameState: ReturnType<SimulationEngine['getGameState']> }
  | { status: 'complete'; gameState: ReturnType<SimulationEngine['getGameState']> }
  | { status: 'busy' };

wss.on('connection', (ws: WebSocket) => {
  ws.send(
    JSON.stringify({
      type: 'init',
      data: { gameState: simulation.getGameState(), hexagons: simulation.getAllHexagons(), config },
    })
  );
});

function broadcast(message: any) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

function broadcastUpdate(gameState: any) {
  broadcast({
    type: 'update',
    data: { gameState, hexagons: simulation.getAllHexagons(), events: simulation.getRecentEvents(1) },
  });
}

// --- State / config ---

app.get('/api/state', (_req, res) => {
  try {
    res.json({
      gameState: simulation.getGameState(),
      hexagons: simulation.getAllHexagons(),
      events: simulation.getRecentEvents(10),
      config,
    });
  } catch {
    res.status(500).json({ error: 'Failed to get state' });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ config });
});

/**
 * Update config. World-gen changes (seed/world) regenerate the world; all other
 * changes apply live to the next round.
 */
app.post('/api/config', async (req, res) => {
  try {
    const overrides = (req.body ?? {}) as DeepPartial<SimConfig>;
    const reinit = requiresReinit(overrides);
    config = applyConfig(config, overrides);

    if (reinit) {
      stopPlaying();
      dbInitializer.setConfig(config);
      dbInitializer.reset();
      dbInitializer.initialize();
    }
    simulation.setConfig(config);
    director = makeDirector(config);
    await director.initialize();

    if (reinit) {
      broadcast({
        type: 'reset',
        data: { gameState: simulation.getGameState(), hexagons: simulation.getAllHexagons(), config },
      });
    }
    res.json({ message: reinit ? 'Config applied (world regenerated)' : 'Config applied', config });
  } catch (error) {
    console.error('Error applying config:', error);
    res.status(500).json({ error: 'Failed to apply config' });
  }
});

// --- Transport ---

app.post('/api/step', async (_req, res) => {
  try {
    const result = await runOneRound();
    if (result.status === 'busy') return res.status(409).json({ error: 'A round is already running' });
    if (result.status === 'complete')
      return res.json({ message: 'Simulation complete', gameState: result.gameState });

    broadcastUpdate(result.gameState);
    res.json({ message: 'Round completed', gameState: result.gameState });
  } catch (error) {
    console.error('Error in step:', error);
    res.status(500).json({ error: 'Failed to run round' });
  }
});

app.post('/api/play', (req, res) => {
  if (isPlaying) return res.json({ message: 'Already playing' });
  if (simulation.getGameState().current_round >= config.totalRounds)
    return res.json({ message: 'Simulation already complete' });

  // Speed: optional intervalMs (fast-forward = smaller interval). Default 2000.
  const intervalMs = Math.max(100, Number(req.body?.intervalMs) || 2000);
  isPlaying = true;

  playInterval = setInterval(async () => {
    try {
      const result = await runOneRound();
      if (result.status === 'busy') return; // previous round still running; skip this tick
      if (result.status === 'complete') {
        stopPlaying();
        broadcast({ type: 'complete', data: { gameState: result.gameState } });
        return;
      }
      broadcastUpdate(result.gameState);
    } catch (error) {
      console.error('Error in play loop:', error);
      stopPlaying();
    }
  }, intervalMs);

  res.json({ message: 'Playing started', intervalMs });
});

app.post('/api/pause', (_req, res) => {
  if (!isPlaying) return res.json({ message: 'Not playing' });
  stopPlaying();
  res.json({ message: 'Playing stopped' });
});

function stopPlaying() {
  isPlaying = false;
  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
  }
}

// --- History / rewind (scrub + fork) ---

app.get('/api/history/:round', (req, res) => {
  try {
    const round = Number(req.params.round);
    const snapshot = simulation.getHistoryForRound(round);
    if (snapshot.length === 0) return res.status(404).json({ error: `No snapshot for round ${round}` });
    res.json({ round, snapshot });
  } catch {
    res.status(500).json({ error: 'Failed to read history' });
  }
});

/** Rewind live state to a recorded round; subsequent steps re-simulate forward. */
app.post('/api/fork', async (req, res) => {
  try {
    const round = Number(req.body?.round);
    if (!Number.isInteger(round) || round < 0)
      return res.status(400).json({ error: 'round must be a non-negative integer' });

    stopPlaying();
    const gameState = simulation.forkFromRound(round);
    broadcast({
      type: 'reset',
      data: { gameState, hexagons: simulation.getAllHexagons(), config },
    });
    res.json({ message: `Forked from round ${round}`, gameState });
  } catch (error) {
    console.error('Error forking:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get('/api/runs', (_req, res) => {
  try {
    const db = dbInitializer.getDatabase();
    const runs = db
      .prepare('SELECT run_id, MIN(round) AS first_round, MAX(round) AS last_round FROM history GROUP BY run_id')
      .all();
    res.json({ runs, currentRunId: simulation.getGameState().run_id });
  } catch {
    res.status(500).json({ error: 'Failed to list runs' });
  }
});

app.post('/api/reset', async (_req, res) => {
  try {
    stopPlaying();
    dbInitializer.setConfig(config);
    dbInitializer.reset();
    dbInitializer.initialize();
    director = makeDirector(config);
    await director.initialize();

    const gameState = simulation.getGameState();
    broadcast({
      type: 'reset',
      data: { gameState, hexagons: simulation.getAllHexagons(), config },
    });
    res.json({ message: 'Simulation reset', gameState });
  } catch (error) {
    console.error('Error in reset:', error);
    res.status(500).json({ error: 'Failed to reset' });
  }
});

initializeApp().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}\n`);
  });
});

process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  stopPlaying();
  if (dbInitializer) dbInitializer.close();
  process.exit(0);
});
