# ABBADON Phase 1 - Implementation Plan

## 1. Assessment: Current State vs. New Requirements

### Executive Summary

The current implementation is a **functional prototype** with a fundamentally different architecture than what the new instructions specify. This is essentially a **major redesign** requiring significant changes to:

- Project structure (monorepo vs flat)
- Database schema (population-based vs group-based)
- Simulation model (population flows vs group behaviors)
- Turn architecture (single-pass vs 5-phase)
- Frontend (Canvas 2D vs React + Pixi.js)
- LLM integration (generative-ai vs Interactions API)

---

## 2. Detailed Comparison

### 2.1 Project Structure

| Aspect | Current | New Requirement |
|--------|---------|-----------------|
| Layout | Flat `src/` + `public/` | Monorepo: `client/`, `server/`, `shared/` |
| Frontend | Vanilla HTML/CSS/JS | React + TypeScript |
| Rendering | Canvas 2D | Pixi.js |
| Build | Single TypeScript project | Separate client/server builds |

**Impact**: Medium - Requires restructuring, but code logic can be migrated.

### 2.2 Database Schema

| Current Tables | New Tables Required |
|----------------|---------------------|
| hexagons (100 hexes) | hexagons (25 hexes, different structure) |
| edges | (removed - implicit adjacency in 5x5 grid) |
| game_state | climate_state (persistent climate tracking) |
| history | group_history (per-group decision tracking) |
| events | events (similar, enhanced) |
| - | **groups** (~150 groups with complex attributes) |
| - | **turns** (turn records with interaction IDs) |
| - | **prompts** (editable LLM prompts) |
| - | **migrations** (detailed migration tracking) |
| - | **factions** (emergent factions) |
| - | **group_relationships** (inter-group relationships) |

**Hexagon Schema Changes**:
- Current: 100 hexes (20 urban, 80 rural), forces, infrastructure details
- New: 25 hexes (5x5 grid), terrain_type (urban/suburban/farmland/forest/water/wasteland), repulsion_score, attraction_score, violence tracking

**Impact**: HIGH - Complete schema redesign required.

### 2.3 Simulation Model

| Aspect | Current | New |
|--------|---------|-----|
| Unit | Population (numbers) | Groups (~150 entities) |
| Movement | Population flows via forces | Group decisions (migrations, raids) |
| Behaviors | Implicit (force-based) | Explicit (character types, attitudes, moves) |
| Decisions | LLM-driven weather/events | Behavioral engine with dice rolls |
| Factions | None | Emergent from group clustering |

**Current Model**:
- Hexes have population counts
- Population flows based on attractor/repulsor forces
- LLM decides weather and events
- Simple resource consumption/production

**New Model**:
- ~150 groups distributed across 25 hexes
- Each group has: size, move, attitude, character_type, cohesion, morale, loyalty
- Behavioral engine computes decisions with randomness
- LLM generates climate events (as game master)
- Faction formation when 3+ similar groups cluster

**Impact**: VERY HIGH - Fundamental model change.

### 2.4 Turn Architecture

| Current (Single Pass) | New (5 Phases) |
|----------------------|----------------|
| 1. Get LLM decision | **Phase 1**: Environment Baseline (server) |
| 2. Apply weather | **Phase 2**: LLM Event Generation |
| 3. Apply events | **Phase 3**: Behavioral Engine (server) |
| 4. Decay infrastructure | **Phase 4**: Action Resolution (server) |
| 5. Calculate forces | **Phase 5**: LLM Lagebericht |
| 6. Execute flows | |
| 7-12. Resources, deaths, etc. | |

**Current**: ~12 steps in single pass, LLM provides narrative + events
**New**: 5 distinct phases, LLM called twice (events + lagebericht), behavioral engine handles group decisions

**Impact**: HIGH - Complete turn logic rewrite.

### 2.5 LLM Integration

| Aspect | Current | New |
|--------|---------|-----|
| Package | @google/generative-ai | @google/genai v1.33.0+ |
| API | generateContent() | Interactions API (with conversation chain) |
| Model | gemini-2.0-flash-exp | gemini-3-flash-preview |
| Calls/Turn | 1 | 2 (events + lagebericht) |
| Context | Rebuilt each call | Maintained via interaction_id chain |
| Schema | Informal JSON | Structured response_format |

**Impact**: HIGH - Different API, different approach.

### 2.6 Frontend

| Aspect | Current | New |
|--------|---------|-----|
| Framework | Vanilla JS | React + TypeScript |
| Rendering | Canvas 2D | Pixi.js |
| Grid | 10x10 rectangles | 5x5 hexagons |
| State | WebSocket push | React state + API polling |
| Components | Monolithic app.js | Modular (HexGrid, LogPanel, Controls, etc.) |

**Impact**: HIGH - Complete frontend rewrite.

### 2.7 Group System (NEW)

The new spec requires a complete group system that doesn't exist:

```typescript
interface Group {
  id: number;
  hex_id: number;
  size: number;
  move: 'MAINTAIN_STATUS_QUO' | 'RAIDING' | 'ORGANIZED_FLIGHT' | 'DESPERATE_FLIGHT' | 'FORTIFY_POSITION' | 'RESOURCE_ACQUISITION';
  attitude: 'COMPLIANT' | 'AUTONOMOUS' | 'RESISTANT' | 'COOPERATIVE' | 'COMPETITIVE' | 'HOSTILE';
  character_type: 'normal' | 'violent' | 'survivalist' | 'technocratic';
  cohesion: number;
  morale: number;
  loyalty: number;
  faction_id?: string;
}
```

Character type behaviors:
- **normal**: Risk-averse, follows authority, flees when desperate
- **violent**: Raids when hungry, low threshold for violence
- **survivalist**: Hoards, fortifies, resists fleeing
- **technocratic**: Prioritizes infrastructure maintenance

**Impact**: VERY HIGH - Entirely new subsystem.

### 2.8 Behavioral Engine (NEW)

The new spec requires deterministic behavioral rules with dice rolls:

- Flight decisions based on repulsion scores + character type
- Raid decisions based on desperation + violence tendency
- Character shifts from trauma/abandonment
- Faction formation from group clustering

This doesn't exist in current implementation.

**Impact**: VERY HIGH - New subsystem to build.

---

## 3. Migration Strategy Options

### Option A: Incremental Migration
Gradually modify existing code to match new spec.

**Pros**: Preserves working code, lower risk per change
**Cons**: Harder to maintain two architectures, longer timeline, messy transitions

### Option B: Parallel Rebuild
Build new system alongside existing, then switch.

**Pros**: Clean architecture, can reference working code
**Cons**: Duplicate work during transition, needs clear cutover

### Option C: Fresh Start with Reference
Rebuild from scratch using new spec, reference existing for patterns.

**Pros**: Cleanest architecture, follows spec exactly
**Cons**: Loses working prototype, must re-implement everything

### Recommendation: Option B (Parallel Rebuild)

The architectural differences are too significant for incremental migration. Build the new system in the new structure while keeping the existing prototype for reference. This allows:

1. Clean implementation of new architecture
2. Reference existing working patterns (LLM integration, database operations)
3. Clear separation during development
4. Ability to compare outputs once new system works

---

## 4. Implementation Plan

### Phase 0: Setup (Day 1)

**0.1 Create Monorepo Structure**
```
abbadon-phase1/
├── client/
│   ├── src/
│   │   ├── components/
│   │   ├── services/
│   │   └── App.tsx
│   ├── package.json
│   └── tsconfig.json
├── server/
│   ├── src/
│   │   ├── routes/
│   │   ├── services/
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
├── shared/
│   ├── types.ts
│   └── package.json
└── package.json (workspace root)
```

**0.2 Install Dependencies**
- Server: express, better-sqlite3, @google/genai v1.33.0+, dotenv, cors
- Client: react, react-dom, pixi.js, typescript, vite
- Shared: typescript

**0.3 Configure TypeScript**
- Set up project references between packages
- Configure shared types import

---

### Phase 1: Shared Types & Database (Days 2-3)

**1.1 Implement Shared Types** (`shared/types.ts`)
- Hex interface (new structure with terrain_type, repulsion/attraction scores)
- ClimateState interface
- Group interface (full behavioral attributes)
- Faction interface
- Migration interface
- GroupRelationship interface
- GameEvent interface
- LLMResponse interfaces (for both phases)
- TurnResult interface

**1.2 Implement Database Schema** (`server/src/db/`)
- Create all 10 tables as specified
- Write migration/init script
- Implement CRUD operations for each table
- Add indexes for performance

**1.3 Implement Initial Data Generation**
- 25 hexagons in 5x5 grid (10 urban, 8 suburban, 7 farmland)
- Climate state with starting values
- ~150 groups distributed by hex population
- Default prompts (system_instruction, event_generation_template, lagebericht_template)

---

### Phase 2: Simulation Engine Core (Days 4-7)

**2.1 Phase 1: Environment Baseline**
```typescript
// Persistent climate state updates
updateClimateState(state: ClimateState): ClimateState

// Resource calculations
calculateFoodProduction(hex: Hex, season: string): number
calculateFoodConsumption(hex: Hex): number
calculateWaterAvailability(hex: Hex, climate: ClimateState): number

// Infrastructure decay
applyInfrastructureDecay(hexes: Hex[], climate: ClimateState): void

// Deaths and births
calculateStarvationDeaths(hex: Hex): number
calculateDehydrationDeaths(hex: Hex): number
calculateBirths(hex: Hex): number

// Push/pull scores
calculateRepulsionScore(hex: Hex): number
calculateAttractionScore(hex: Hex): number

// Build situation summary for LLM
buildSituationSummary(hexes: Hex[], groups: Group[], climate: ClimateState, turn: number): SituationSummary
```

**2.2 Phase 2: LLM Event Generation**
```typescript
// Gemini Interactions API integration
async generateClimateEvents(summary: SituationSummary, previousInteractionId?: string): Promise<LLMEventResponse>

// Event application
applyClimateEvent(event: ClimateEvent, hexes: Hex[], climate: ClimateState): void
```

**2.3 Phase 3: Behavioral Engine**
```typescript
// Group decision logic with dice rolls
evaluateGroupFlight(group: Group, hex: Hex): FlightDecision | null
evaluateGroupRaid(group: Group, hex: Hex, neighbors: Hex[]): RaidDecision | null
evaluateCharacterShift(group: Group, hex: Hex): CharacterShift | null
evaluateFactionFormation(groups: Group[], hex: Hex): FactionFormation | null

// Find destinations
findHighestAttractionHex(group: Group, maxDistance: number): Hex | null
findWeakNeighborWithFood(group: Group): Hex | null
```

**2.4 Phase 4: Action Resolution**
```typescript
// Execute migrations
executeMigration(group: Group, destination: Hex, type: 'organized' | 'desperate'): Migration

// Execute raids
executeRaid(attacker: Group, targetHex: Hex, defenders: Group[]): RaidResult

// Update hex states
recalculateHexPopulations(hexes: Hex[], groups: Group[]): void
updateHexControl(hex: Hex, groups: Group[], factions: Faction[]): void

// Group lifecycle
dissolveSmallGroups(groups: Group[]): number[]
```

**2.5 Phase 5: LLM Lagebericht**
```typescript
// Generate comprehensive narrative
async generateLagebericht(whatHappened: TurnSummary, previousInteractionId: string): Promise<LageberichtResponse>
```

---

### Phase 3: API Layer (Days 8-9)

**3.1 Implement REST Endpoints**
```
POST /api/simulation/init          - Initialize new game
POST /api/simulation/turn/:turn    - Execute full 5-phase turn
GET  /api/simulation/state         - Get current state
GET  /api/simulation/hex/:hexId    - Get hex details with migrations
GET  /api/simulation/turns         - Get all turn records
GET  /api/simulation/migrations/:turn - Get migrations for turn
GET  /api/simulation/prompts       - Get editable prompts
PUT  /api/simulation/prompts/:name - Update prompt
```

**3.2 Error Handling**
- Wrap all Gemini API calls with retry logic
- Handle interaction chain expiration (404 fallback)
- Validate LLM JSON responses
- Database transaction rollback on failure

---

### Phase 4: Frontend Foundation (Days 10-12)

**4.1 React App Setup**
- Vite + React + TypeScript configuration
- Routing (if needed)
- API service layer with fetch

**4.2 Core Layout**
```
┌─────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────┐   │
│  │              HexGrid (Pixi.js, 66%)              │   │
│  │                                                   │   │
│  │     [Hexagonal tiles with colors/numbers]        │   │
│  │                                                   │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │              LogPanel (33%)                       │   │
│  │    [Lageberichte, turn stats, events]            │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Controls: [Init] [Next Turn] Turn: 5/60         │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                      ┌────────────────┐
                      │  HexDetails    │  (Modal on hex click)
                      │  Modal         │
                      └────────────────┘
                                          ┌─────────────┐
                                          │ Preferences │ (Slide-in panel)
                                          │   Panel     │
                                          └─────────────┘
```

**4.3 Pixi.js HexGrid Component**
- 5x5 hexagonal grid with 60px radius hexes
- Color coding by control (player=blue, factions=red/orange, anarchic=gray)
- Terrain indicator triangles
- Population numbers
- Migration arrow overlay (optional toggle)
- Click handling for hex selection

**4.4 Supporting Components**
- LogPanel: Scrollable Lagebericht display
- HexDetails: Modal with hex info, groups, migrations
- Controls: Init/Next Turn buttons, turn counter
- PreferencesPanel: Prompt editor

---

### Phase 5: Integration & Testing (Days 13-15)

**5.1 End-to-End Flow Testing**
- Initialize game → verify 25 hexes, 150 groups
- Run single turn → verify all 5 phases execute
- Verify database state changes
- Verify frontend updates

**5.2 Simulation Quality Validation**
Run 12 turns and verify:
- Population loss 40-60%
- Urban hexes depopulating
- Rural hexes receiving migrants
- Factions forming
- Violence spreading
- Infrastructure degrading

**5.3 Error Scenario Testing**
- LLM timeout → verify fallback
- Interaction chain break → verify context rebuild
- Malformed JSON → verify error display
- Network failure → verify retry

---

### Phase 6: Polish & Documentation (Day 16)

**6.1 UI Polish**
- Loading states during turn execution
- Error toast notifications
- Smooth migration animations
- Responsive layout

**6.2 Code Cleanup**
- Remove unused code
- Add essential comments
- Ensure type safety throughout

---

## 5. File-by-File Implementation Checklist

### Shared Package (`shared/`)
- [ ] `types.ts` - All interfaces from spec

### Server Package (`server/`)
- [ ] `src/db/schema.ts` - Table definitions
- [ ] `src/db/init.ts` - Database initialization
- [ ] `src/db/operations.ts` - CRUD operations
- [ ] `src/services/gemini.ts` - Interactions API wrapper
- [ ] `src/services/simulation/phase1-environment.ts`
- [ ] `src/services/simulation/phase2-llm-events.ts`
- [ ] `src/services/simulation/phase3-behavioral.ts`
- [ ] `src/services/simulation/phase4-resolution.ts`
- [ ] `src/services/simulation/phase5-lagebericht.ts`
- [ ] `src/services/simulation/index.ts` - Turn orchestrator
- [ ] `src/routes/simulation.ts` - API endpoints
- [ ] `src/index.ts` - Express server

### Client Package (`client/`)
- [ ] `src/services/api.ts` - API client
- [ ] `src/components/HexGrid.tsx` - Pixi.js hex renderer
- [ ] `src/components/LogPanel.tsx` - Lagebericht display
- [ ] `src/components/HexDetails.tsx` - Hex detail modal
- [ ] `src/components/Controls.tsx` - Buttons and turn counter
- [ ] `src/components/PreferencesPanel.tsx` - Prompt editor
- [ ] `src/App.tsx` - Main layout

---

## 6. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Gemini 3 Flash not available | Low | High | Use gemini-2.0-flash as fallback |
| Interactions API different from spec | Medium | Medium | Adapt to actual API |
| LLM produces invalid JSON | High | Medium | Strict schema validation + retry |
| Behavioral engine too predictable | Medium | Medium | Tune dice roll probabilities |
| Frontend performance with Pixi | Low | Low | Optimize draw calls |
| Simulation doesn't produce expected outcomes | Medium | High | Extensive parameter tuning |

---

## 7. Success Criteria

The implementation is complete when:

1. **Structure**: Monorepo with client/server/shared packages builds and runs
2. **Init**: POST /api/simulation/init creates 25 hexes, 150 groups, climate state
3. **Turn Execution**: All 5 phases execute without error
4. **Frontend**: Pixi.js grid renders with controls and details
5. **Simulation Quality** (12 turns):
   - Population loss 40-60%
   - Migrations visible (arrows on grid)
   - At least 1 faction forms
   - Urban hexes depopulate, rural absorb then strain
6. **Error Handling**: Graceful handling of LLM failures

---

## 8. Appendix: Key Code Patterns to Preserve

### From Current Implementation

**Database Operations** (`src/init.ts`):
- Transaction patterns with better-sqlite3
- WAL mode for performance

**LLM Integration** (`src/llm.ts`):
- Token-efficient state updates (only changes)
- Progression guidance based on round
- Fallback to deterministic when LLM fails

**Force Calculations** (`src/simulation.ts`):
- Attractor/repulsor pattern → repulsion/attraction scores
- Edge permeability → migration casualty calculations

These patterns can inform the new implementation even though the architecture changes.

---

## 9. Estimated Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| 0: Setup | 1 day | None |
| 1: Types & DB | 2 days | Phase 0 |
| 2: Simulation Engine | 4 days | Phase 1 |
| 3: API Layer | 2 days | Phase 2 |
| 4: Frontend | 3 days | Phase 3 |
| 5: Integration | 3 days | Phase 4 |
| 6: Polish | 1 day | Phase 5 |

**Total: ~16 days of development**

This plan provides a roadmap for the complete rebuild while preserving learnings from the current prototype.
