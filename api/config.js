import { currentConfig, applyConfigChange, loadWorld, payload } from './_db.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ config: await currentConfig() });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

    const overrides = req.body ?? {};
    const { reinit, state } = await applyConfigChange(overrides);
    if (reinit) {
      return res.status(200).json({ message: 'Config applied (world regenerated)', ...(await payload(state)) });
    }
    const current = await loadWorld();
    res.status(200).json({ message: 'Config applied', ...(await payload(current)) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
