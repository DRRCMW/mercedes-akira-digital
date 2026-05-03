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

  // notion-pull: all 312 Notion Prospect Finder leads
  if (action === 'notion-pull') {
    const NT = process.env.NOTION_TOKEN || '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';
    const DB = 'a3d2c021b2cc4aed983b10886908824a';
    try {
      const all = [];
      let cursor = null;
      let page = 0;
      do {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const nr = await fetch('https://api.notion.com/v1/databases/' + DB + '/query', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + NT, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const nd = await nr.json();
        if (!nr.ok) return res.status(500).json({ error: nd.message });
        all.push(...(nd.results || []));
        cursor = nd.has_more ? nd.next_cursor : null;
        page++;
      } while (cursor && page < 20);
      const leads = all.map((rec, i) => {
        const p = rec.properties || {};
        const name = (p['Business Name']?.title || [])[0]?.plain_text || '';
        if (!name) return null;
        const phone = p['Phone']?.phone_number || '';
        const city = (p['City']?.rich_text || [])[0]?.plain_text || 'Los Angeles';
        const state = (p['State']?.rich_text || [])[0]?.plain_text || 'CA';
        const rating = p['Google Rating']?.number || 4.5;
        const reviews = p['Review Count']?.number || 0;
        const tier = p['Lead Score']?.select?.name || 'Hot';
        const outreach = p['Outreach Status']?.select?.name || 'Not Started';
        let stage = 'new';
        if (['Day 1 Sent','Day 3 Sent','Day 7 Sent','Day 14 Sent','Day 21 Sent'].includes(outreach)) stage = 'contacted';
        else if (outreach === 'Responded' || outreach === 'Meeting Booked') stage = 'meeting';
        else if (outreach === 'Closed Won') stage = 'won';
        else if (outreach === 'Closed Lost') stage = 'lost';
        const addedAt = rec.created_time || '';
        return { place_id: 'notion-' + rec.id.replace(/-/g,''), notion_id: rec.id, name, phone, address: city + ', ' + state + ', USA', city, state, rating, reviews, score: Math.min(100, Math.round(rating*10+(reviews>20?10:0))), tier, reason: (p['Website Status']?.select?.name||'No Website'), angle: 'Notion Prospect Finder', stage, touchpoints: [], nextFollowup: null, addedAt, uid: new Date(addedAt).getTime() + i };
      }).filter(Boolean);
      return res.status(200).json({ total: leads.length, pages: page, leads });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: 'Unknown action. Use: push-pipeline, pull-all, clear-queue, get-log, status' });
}
