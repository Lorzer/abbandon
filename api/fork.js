import { loadWorld, saveFork, payload } from './_db.js';
import { SimulationEngine } from '../dist/simulation.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const round = Number(req.body?.round);
  if (!Number.isInteger(round) || round < 0) {
    return res.status(400).json({ error: 'round must be a non-negative integer' });
  }
  try {
    const state = await loadWorld({ withHistory: true });
    const sim = new SimulationEngine(state);
    sim.forkFromRound(round);
    await saveFork(state, round);
    res.status(200).json({ message: `Forked from round ${round}`, ...(await payload(state)) });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
}
