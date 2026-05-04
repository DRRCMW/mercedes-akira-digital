    const NT = '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';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mercedes-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const key = req.headers['x-mercedes-key'] || req.query.key;
  if (key !== (process.env.MERCEDES_SECRET || 'Mercedes2707')) return res.status(401).json({ error: 'Unauthorized' });
  const action = req.query.action || req.body?.action;
  const RU = process.env.UPSTASH_REDIS_REST_URL;
  const RT = process.env.UPSTASH_REDIS_REST_TOKEN;

  async function rGet(k) {
    if (!RU) return null;
    try {
      const r = await fetch(RU + '/get/' + encodeURIComponent(k), { headers: { Authorization: 'Bearer ' + RT } });
      const d = await r.json();
      if (!d.result) return null;
      let val = JSON.parse(d.result);
      if (typeof val === 'string') val = JSON.parse(val);
      return val;
    } catch (e) { return null; }
  }

  async function rSet(k, v) {
    if (!RU) return false;
    try {
      await fetch(RU + '/set/' + encodeURIComponent(k), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RT, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(v))
      });
      return true;
    } catch (e) { return false; }
  }

  if (action === 'pull-all' && req.method === 'GET') {
    const pipeline = await rGet('akira_pipeline') || [];
    const queue = await rGet('akira_queue') || [];
    const workedToday = await rGet('akira_worked_today') || false;
    const lastRun = await rGet('akira_last_run') || null;
    const log = await rGet('akira_log') || [];
    return res.status(200).json({ pipeline, queue, workedToday, lastRun, log });
  }

  if ((action === 'push' || action === 'push-pipeline') && req.method === 'POST') {
    const body = req.body || {};
    if (body.pipeline) await rSet('akira_pipeline', body.pipeline);
    if (body.queue !== undefined) await rSet('akira_queue', body.queue);
    if (body.workedToday !== undefined) await rSet('akira_worked_today', body.workedToday);
    await rSet('akira_last_run', new Date().toISOString());
    return res.status(200).json({ ok: true, pipeline: body.pipeline?.length || 0 });
  }

  if (action === 'clear-queue') { await rSet('akira_queue', []); return res.status(200).json({ ok: true }); }
  if (action === 'get-log') { const log = await rGet('akira_log') || []; return res.status(200).json({ log }); }

  if (action === 'notion-pull') {
    const NT = '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';
    const DB = 'a3d2c021b2cc4aed983b10886908824a';
    try {
      const all = []; let cursor = null; let page = 0;
      do {
        const body = { page_size: 100 }; if (cursor) body.start_cursor = cursor;
        const nr = await fetch('https://api.notion.com/v1/databases/' + DB + '/query', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + NT, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const nd = await nr.json();
        if (!nr.ok) return res.status(500).json({ error: 'Notion error', detail: nd });
        all.push(...(nd.results || [])); cursor = nd.has_more ? nd.next_cursor : null; page++;
      } while (cursor && page < 20);
      const leads = all.map((rec, i) => {
        const p = rec.properties || {};
        const name = (p['Business Name']?.title || [])[0]?.plain_text || 'Unknown';
        const phone = p['Phone']?.phone_number || '';
        const city = (p['City']?.rich_text || [])[0]?.plain_text || 'Los Angeles';
        const state = (p['State']?.rich_text || [])[0]?.plain_text || 'CA';
        const rating = p['Google Rating']?.number || 4.5;
        const reviews = p['Review Count']?.number || 0;
        const tier = p['Lead Score']?.select?.name || 'Hot';
        const outreach = p['Outreach Status']?.select?.name || 'Not Started';
        const website = p['Website Status']?.select?.name || 'No Website';
        const niche = p['Niche']?.select?.name || 'Other';
        const addedAt = rec.created_time || '';
        let stage = 'new';
        if (['Day 1 Sent','Day 3 Sent','Day 7 Sent','Day 14 Sent','Day 21 Sent'].includes(outreach)) stage = 'contacted';
        else if (outreach === 'Responded' || outreach === 'Meeting Booked') stage = 'meeting';
        else if (outreach === 'Closed Won') stage = 'won';
        else if (outreach === 'Closed Lost') stage = 'lost';
        return { place_id: 'notion-' + rec.id.replace(/-/g, ''), notion_id: rec.id, name, phone, address: city + ', ' + state + ', USA', city, state, rating, reviews, score: Math.min(100, Math.round(rating * 10 + (reviews > 20 ? 10 : 0))), tier, niche, reason: website, angle: 'Notion Prospect Finder', stage, touchpoints: [], nextFollowup: null, addedAt, uid: new Date(addedAt).getTime() + i };
      });
      return res.status(200).json({ total: leads.length, pages: page, leads });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'status') {
    const pipeline = await rGet('akira_pipeline') || [];
    const lastRun = await rGet('akira_last_run');
    return res.status(200).json({ ok: true, pipeline_count: Array.isArray(pipeline) ? pipeline.length : 0, last_run: lastRun, redis_connected: !!RU, message: 'Sync API working' });
  }

  return res.status(400).json({ error: 'Unknown action', action });
}

// env: notion token updated
