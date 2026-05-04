export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const key = req.headers['x-mercedes-key'] || req.query.key;
  if (key !== 'Mercedes2707') return res.status(401).json({ error: 'Unauthorized' });
  const action = req.query.action;
  if (action === 'status') return res.status(200).json({ ok: true, message: 'Sync API working' });
  if (action === 'pull-all') return res.status(200).json({ pipeline: [], queue: [], workedToday: false, lastRun: null, log: [] });
  return res.status(400).json({ error: 'Unknown action' });
}
