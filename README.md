# ABBADON Phase 1 - Climate Collapse Simulation

A strategic simulation prototype that models climate-induced societal collapse in the Berlin-Brandenburg-MV region over 60 rounds (5 years).

## Overview

ABBADON Phase 1 is a **pure simulation prototype** - no player interaction yet, just observing the system evolve. The goal is to validate the core engine before adding player controls in Phase 2.

### What It Simulates

- **100 hexagons** (20 urban, 80 rural) representing the region
- **~1 million people** distributed across hexagons
- **Population flows** driven by attractors (food, water, safety) and repulsors (shortage, violence)
- **LLM-generated events** - Gemini 2.0 Flash decides monthly climate events and narrative
- **Resource dynamics** - production, consumption, and starvation

## Quick Start

### 1. Prerequisites

- Node.js (v18 or higher)
- Google Gemini API key ([Get one here](https://aistudio.google.com/app/apikey))

### 2. Setup

```bash
# Clone or navigate to the project directory
cd abbadon

# Install dependencies (already done if you see this)
npm install

# Create .env file with your API key
cp .env.example .env
# Edit .env and add your GOOGLE_API_KEY
```

### 3. Run

```bash
npm start
```

Open your browser to: **http://localhost:3000**

## Usage

### Controls

- **Play** - Auto-run simulation (1 round every 2 seconds)
- **Pause** - Stop auto-run
- **Step** - Advance exactly 1 round
- **Reset** - Clear database and start over

### What to Watch

- **Urban hexes** (top-left, 0-1 rows) should lose population as people evacuate
- **Rural hexes** (rest) should absorb population as they arrive
- **Population numbers** decrease overall due to deaths
- **Food** depletes then partially recovers from rural production
- **Console log** shows LLM narrative each round
- By round 30-40, expect clear urban → rural redistribution

### Visualization

- **Green** = Low population (&lt;5k)
- **Orange** = Medium-high population (5k-30k)
- **Red** = Very high population (30k+)
- **Black** = Depleted (&lt;100 people)
- **Yellow border** = Selected hex (click to select)

## Architecture

### Core Concept

**Three-layer architecture:**

1. **Hexagons (Space)** - 100 hexagons with terrain, population, resources, infrastructure
2. **Population (Particle Flow)** - Population flows like fluid from repulsors to attractors
3. **LLM Director** - Gemini decides monthly events, maintains narrative continuity

### Simulation Loop (Each Round)

1. LLM decides events (weather, crises)
2. Apply weather effects (global)
3. Apply triggered events (specific hexes)
4. Calculate forces (attractors vs repulsors)
5. Population flows (people move)
6. Resources consumed (everyone needs food)
7. Resources produced (rural hexes)
8. Starvation deaths (no food = 10% die)
9. Update state and save history

### Token Efficiency

- **Round 1**: Full state (~10k tokens)
- **Rounds 2-60**: Only changes (~1k tokens each)
- **Total**: ~70k tokens vs 600k if sending full state every round
- **Savings**: 88%

## Tech Stack

- **Backend**: TypeScript + Express + SQLite + WebSocket
- **Frontend**: HTML + CSS + Canvas 2D
- **LLM**: Google Gemini 2.0 Flash Experimental

## Initial Conditions

**Round 0:**
- 20 urban hexes: 40,000 people each = 800,000 total
- 80 rural hexes: 2,500 people each = 200,000 total
- **Total: 1,000,000 people**
- Urban: 200 tons food, 0 production
- Rural: 50 tons food, 25 tons/month production
- All infrastructure: 85-90%

**Expected Progression:**
- Rounds 1-10: Slight degradation, minimal movement
- Rounds 10-20: Urban food runs out → people evacuate
- Rounds 20-40: Mass exodus to rural areas
- Rounds 40-60: New equilibrium or collapse

## Success Criteria

The prototype works if:

- ✓ Simulation runs 60 rounds without crashing
- ✓ Urban population decreases (evacuates)
- ✓ Rural population increases (absorbs)
- ✓ Deaths occur (starvation + transit)
- ✓ LLM generates coherent narratives
- ✓ Forces drive realistic population flow
- ✓ Infrastructure degrades over time
- ✓ Food production sustains some population
- ✓ System reaches equilibrium or collapses

## File Structure

```
abbadon/
├── src/
│   ├── types.ts          # TypeScript interfaces
│   ├── init.ts           # Database initialization
│   ├── simulation.ts     # Core simulation engine
│   ├── llm.ts            # LLM Director (Gemini)
│   └── server.ts         # Express + WebSocket server
├── public/
│   ├── index.html        # UI structure
│   ├── style.css         # Dark theme styling
│   └── app.js            # Frontend logic + Canvas
├── package.json
├── tsconfig.json
├── .env                  # API keys (not in git)
└── abbadon.db           # SQLite database (created on first run)
```

## Database Schema

- **hexagons** - Current state of all 100 hexes
- **edges** - Connections between adjacent hexagons
- **game_state** - Global state (round, population, deaths)
- **history** - Snapshots per round (for replay)
- **events** - Log of what happened each round

## Development

```bash
# Run in watch mode (auto-restart on changes)
npm run dev

# Build TypeScript
npm run build

# Clean (remove database and build artifacts)
npm run clean
```

## Troubleshooting

### "GOOGLE_API_KEY not found"
Create a `.env` file in the project root with:
```
GOOGLE_API_KEY=your_key_here
```

### LLM not responding
- Check your API key is valid
- Check your internet connection
- The simulation will use fallback mode if LLM fails (automatic degradation)

### Database locked
Stop the server (Ctrl+C) and try again. If persists:
```bash
npm run clean
npm start
```

## Next Steps (Phase 2)

Once Phase 1 validates the engine:
- Add player controls (you ARE the state)
- Add workforce management
- Add organization types
- Add factions
- Add specialized actors
- Switch to Three.js for 3D visualization

## License

MIT

---

**Built with Claude Code** 🤖
