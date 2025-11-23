/**
 * ABBADON Phase 1 - Express Server + WebSocket
 */

import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { DatabaseInitializer } from './init.js';
import { SimulationEngine } from './simulation.js';
import { LLMDirector } from './llm.js';
import type { GameState, Hexagon } from './types.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Global state
let dbInitializer: DatabaseInitializer;
let simulation: SimulationEngine;
let llmDirector: LLMDirector;
let isPlaying = false;
let playInterval: NodeJS.Timeout | null = null;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Initialize on startup
async function initializeApp() {
  console.log('\n🌍 ABBADON Phase 1 - Initializing...\n');

  // Check for API key
  if (!process.env.GOOGLE_API_KEY) {
    console.error('❌ ERROR: GOOGLE_API_KEY not found in environment variables');
    console.error('Please create a .env file with your Google API key:');
    console.error('GOOGLE_API_KEY=your_key_here\n');
    console.error('Get your key from: https://aistudio.google.com/app/apikey\n');
    process.exit(1);
  }

  // Initialize database
  dbInitializer = new DatabaseInitializer('./abbadon.db');
  const db = dbInitializer.getDatabase();

  // Check if database needs initialization
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  if (tables.length === 0) {
    dbInitializer.initialize();
  } else {
    console.log('✓ Database already initialized');
  }

  // Initialize simulation and LLM
  simulation = new SimulationEngine(db);
  llmDirector = new LLMDirector(process.env.GOOGLE_API_KEY);
  await llmDirector.initialize();

  console.log('\n✓ Server ready!\n');
}

// WebSocket connection handler
wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected');

  // Send initial state
  const gameState = simulation.getGameState();
  const hexagons = simulation.getAllHexagons();
  ws.send(
    JSON.stringify({
      type: 'init',
      data: {
        gameState,
        hexagons,
      },
    })
  );

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Broadcast to all connected clients
function broadcast(message: any) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// API: Get current state
app.get('/api/state', (req, res) => {
  try {
    const gameState = simulation.getGameState();
    const hexagons = simulation.getAllHexagons();
    const events = simulation.getRecentEvents(10);

    res.json({
      gameState,
      hexagons,
      events,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get state' });
  }
});

// API: Step one round
app.post('/api/step', async (req, res) => {
  try {
    const gameState = simulation.getGameState();

    if (gameState.current_round >= 60) {
      return res.json({
        message: 'Simulation complete (60 rounds)',
        gameState,
      });
    }

    // Run one round
    const newGameState = await simulation.runRound(llmDirector);
    const hexagons = simulation.getAllHexagons();
    const events = simulation.getRecentEvents(1);

    // Broadcast update
    broadcast({
      type: 'update',
      data: {
        gameState: newGameState,
        hexagons,
        events,
      },
    });

    res.json({
      message: 'Round completed',
      gameState: newGameState,
    });
  } catch (error) {
    console.error('Error in step:', error);
    res.status(500).json({ error: 'Failed to run round' });
  }
});

// API: Play (auto-run)
app.post('/api/play', (req, res) => {
  if (isPlaying) {
    return res.json({ message: 'Already playing' });
  }

  const gameState = simulation.getGameState();
  if (gameState.current_round >= 60) {
    return res.json({ message: 'Simulation already complete' });
  }

  isPlaying = true;

  playInterval = setInterval(async () => {
    try {
      const currentState = simulation.getGameState();

      if (currentState.current_round >= 60) {
        stopPlaying();
        broadcast({
          type: 'complete',
          data: {
            gameState: currentState,
          },
        });
        return;
      }

      // Run one round
      const newGameState = await simulation.runRound(llmDirector);
      const hexagons = simulation.getAllHexagons();
      const events = simulation.getRecentEvents(1);

      // Broadcast update
      broadcast({
        type: 'update',
        data: {
          gameState: newGameState,
          hexagons,
          events,
        },
      });
    } catch (error) {
      console.error('Error in play loop:', error);
      stopPlaying();
    }
  }, 2000); // One round every 2 seconds

  res.json({ message: 'Playing started' });
});

// API: Pause
app.post('/api/pause', (req, res) => {
  if (!isPlaying) {
    return res.json({ message: 'Not playing' });
  }

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

// API: Reset
app.post('/api/reset', async (req, res) => {
  try {
    // Stop playing if active
    stopPlaying();

    // Reset database
    dbInitializer.reset();
    dbInitializer.initialize();

    // Reinitialize LLM (new chat session)
    llmDirector = new LLMDirector(process.env.GOOGLE_API_KEY!);
    await llmDirector.initialize();

    const gameState = simulation.getGameState();
    const hexagons = simulation.getAllHexagons();

    // Broadcast reset
    broadcast({
      type: 'reset',
      data: {
        gameState,
        hexagons,
      },
    });

    res.json({
      message: 'Simulation reset',
      gameState,
    });
  } catch (error) {
    console.error('Error in reset:', error);
    res.status(500).json({ error: 'Failed to reset' });
  }
});

// Start server
initializeApp().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Open your browser to start the simulation\n`);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  stopPlaying();
  if (dbInitializer) {
    dbInitializer.close();
  }
  process.exit(0);
});
