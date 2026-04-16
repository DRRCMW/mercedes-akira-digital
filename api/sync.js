// ═══════════════════════════════════════════════════════════════
// MERCEDES — Cloud Sync API
// Bridges browser localStorage ↔ Upstash Redis
// Actions: push-pipeline | pull-all | clear-queue | get-log
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mercedes-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── AUTH ──────────────────────────────────────────────────────
  const provided = req.headers['x-mercedes-key'] || req.query.key;
  if (provided !== process.env.MERCEDES_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL) {
    return res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL not configured' });
  }

  // ── REDIS HELPERS ─────────────────────────────────────────────
  async function redisGet(key) {
    const r = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await r.json();
    try { return data.result ? JSON.parse(data.result) : null; } catch { return null; }
  }

  async function redisSet(key, value) {
    const r = await fetch(`${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(value))
    });
    return r.ok;
  }

  const action = req.query.action;

  // ── PUSH PIPELINE → CLOUD ────────────────────────────────────
  // Called by browser when leads are added/updated
  if (action === 'push-pipeline' && req.method === 'POST') {
    const pipeline = req.body;
    if (!Array.isArray(pipeline)) {
      return res.status(400).json({ error: 'Pipeline must be an array' });
    }
    await redisSet('akira_pipeline', pipeline);
    return res.json({ ok: true, count: pipeline.length });
  }

  // ── PULL ALL DATA ← CLOUD ────────────────────────────────────
  // Called by browser on load to get queue + pipeline updates
  if (action === 'pull-all' && req.method === 'GET') {
    const today = new Date().toDateString();
    const [queue, pipeline, workedToday, lastRun, log] = await Promise.all([
      redisGet('mercedes_queue'),
      redisGet('akira_pipeline'),
      redisGet(`worked_${today}`),
      redisGet('mercedes_last_run'),
      redisGet('mercedes_log')
    ]);
    return res.json({
      queue:       queue       || [],
      pipeline:    pipeline    || [],
      workedToday: workedToday || [],
      lastRun:     lastRun     || null,
      log:         (log        || []).slice(0, 50)
    });
  }

  // ── CLEAR QUEUE ───────────────────────────────────────────────
  if (action === 'clear-queue' && req.method === 'POST') {
    await redisSet('mercedes_queue', []);
    return res.json({ ok: true });
  }

  // ── GET LOG ───────────────────────────────────────────────────
  if (action === 'get-log' && req.method === 'GET') {
    const log = await redisGet('mercedes_log') || [];
    return res.json({ log: log.slice(0, 100) });
  }

  // ── STATUS CHECK ──────────────────────────────────────────────
  if (action === 'status' && req.method === 'GET') {
    const lastRun = await redisGet('mercedes_last_run');
    const queue   = await redisGet('mercedes_queue') || [];
    const today   = new Date().toDateString();
    const worked  = await redisGet(`worked_${today}`) || [];
    return res.json({
      status: 'ok',
      lastRun,
      queueSize: queue.length,
      workedToday: worked.length
    });
  }

  return res.status(400).json({ error: 'Unknown action. Use: push-pipeline, pull-all, clear-queue, get-log, status' });
}
