import { loadWorld, saveStep, payload, makeDirector } from './_db.js';
import { SimulationEngine } from '../dist/simulation.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const state = await loadWorld();
    if (state.gameState.current_round >= state.config.totalRounds) {
      return res.status(200).json({ message: 'Simulation complete', ...(await payload(state)) });
    }
    const sim = new SimulationEngine(state);
    await sim.runRound(makeDirector(state.config));
    await saveStep(state);
    res.status(200).json({ message: 'Round completed', ...(await payload(state)) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
