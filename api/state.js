import { loadWorld, payload } from './_db.js';

export default async function handler(_req, res) {
  try {
    const state = await loadWorld();
    res.status(200).json(await payload(state));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
