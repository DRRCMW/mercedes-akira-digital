// MERCEDES -- Pipeline Export Endpoint (read-only)
// GET /api/export?key=SECRET            -> akira_pipeline (all leads)
// GET /api/export?key=SECRET&k=NAME     -> any other redis key (mercedes_queue, mercedes_log)
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mercedes-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const provided = req.headers['x-mercedes-key'] || req.query.key;
  if (provided !== process.env.MERCEDES_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Redis not configured' });

  const keyName = (req.query.k || 'akira_pipeline').replace(/[^a-zA-Z0-9_-]/g, '');

  const r = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${keyName}`, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
  });
  const data = await r.json();

  let value = null;
  try { value = data && data.result ? JSON.parse(data.result) : null; } catch (e) { value = data.result; }

  const arr = Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.values(value) : []);
  return res.status(200).json({ key: keyName, count: arr.length, data: value });
}

