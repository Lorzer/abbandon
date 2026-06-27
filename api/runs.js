import { listRuns } from './_db.js';

export default async function handler(_req, res) {
  try {
    res.status(200).json(await listRuns());
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
