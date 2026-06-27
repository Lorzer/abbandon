import { currentConfig, createNewRun, payload } from './_db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const config = await currentConfig();
    const state = await createNewRun(config);
    res.status(200).json({ message: 'Simulation reset', ...(await payload(state)) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
