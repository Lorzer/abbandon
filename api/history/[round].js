import { historyForRound } from '../_db.js';

export default async function handler(req, res) {
  try {
    const round = Number(req.query.round);
    const snapshot = await historyForRound(round);
    if (!snapshot.length) return res.status(404).json({ error: `No snapshot for round ${round}` });
    res.status(200).json({ round, snapshot });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
