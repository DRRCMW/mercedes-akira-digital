
// ═══════════════════════════════════════════════════════════════
// MERCEDES — Cloud Sync API v2
// Bridges browser localStorage ↔ Upstash Redis ↔ Notion
// Actions: push-pipeline | pull-all | clear-queue | get-log |
//          sync-to-notion | sync-notion-packages
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

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, NOTION_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL not configured' });

  // ── NOTION CONFIG ──────────────────────────────────────────────
  // Your Outbound Targets database ID
  const NOTION_OUTBOUND_DB = 'a3d2c021b2cc4aed983b10886908824a';
  // Your Prospect Pipeline database ID
  const NOTION_PIPELINE_DB = '33c64950aee38023a87cd4702e496bca';

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
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value))
    });
    return r.ok;
  }

  // ── NOTION HELPERS ────────────────────────────────────────────
  async function notionPost(endpoint, body) {
    const r = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  async function notionPatch(endpoint, body) {
    const r = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  async function notionQuery(databaseId, filter) {
    const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(filter || {})
    });
    return r.json();
  }

  // ── MAP LEAD STAGE TO NOTION OUTREACH STATUS ──────────────────
  function mapStageToStatus(stage) {
    const map = {
      'new': 'Not Started',
      'contacted': 'Day 1 Sent',
      'follow-up': 'Day 3 Sent',
      'responded': 'Responded',
      'meeting': 'Meeting Booked',
      'proposal': 'Proposal Sent',
      'closed': 'Closed Won',
      'lost': 'Closed Lost'
    };
    return map[stage] || 'Not Started';
  }

  // ── MAP LEAD SCORE ────────────────────────────────────────────
  function mapLeadScore(lead) {
    if (lead.leadScore === 'hot') return 'Hot';
    if (lead.leadScore === 'warm') return 'Warm';
    if (!lead.website && lead.rating >= 4) return 'Hot';
    if (!lead.website) return 'Warm';
    return 'Cold';
  }

  // ── MAP CATEGORY TO NICHE ─────────────────────────────────────
  function mapNiche(category) {
    if (!category) return 'Other';
    const c = category.toLowerCase();
    if (c.includes('plumb')) return 'Plumber';
    if (c.includes('hvac') || c.includes('heat') || c.includes('air') || c.includes('cool')) return 'HVAC';
    if (c.includes('roof')) return 'Roofer';
    if (c.includes('law') || c.includes('attorney') || c.includes('legal')) return 'Law Firm';
    if (c.includes('contractor') || c.includes('construction') || c.includes('remodel')) return 'General Contractor';
    if (c.includes('landscape') || c.includes('lawn') || c.includes('garden')) return 'Landscaping';
    if (c.includes('pest') || c.includes('exterminator')) return 'Pest Control';
    if (c.includes('electric')) return 'Electrician';
    if (c.includes('clean')) return 'Cleaning Service';
    return 'Other';
  }

  // ── EXTRACT CITY FROM ADDRESS ─────────────────────────────────
  function extractCity(address) {
    if (!address) return '';
    // Format: "123 Main St, Dallas, TX 75001, USA"
    const parts = address.split(',');
    if (parts.length >= 2) return parts[parts.length - 3]?.trim() || parts[1]?.trim() || '';
    return '';
  }

  function extractState(address) {
    if (!address) return '';
    const parts = address.split(',');
    if (parts.length >= 2) {
      const stateZip = parts[parts.length - 2]?.trim() || '';
      return stateZip.split(' ')[0] || '';
    }
    return '';
  }

  const action = req.query.action;

  // ── PUSH PIPELINE → CLOUD ────────────────────────────────────
  if (action === 'push-pipeline' && req.method === 'POST') {
    const pipeline = req.body;
    if (!Array.isArray(pipeline)) return res.status(400).json({ error: 'Pipeline must be an array' });
    await redisSet('akira_pipeline', pipeline);
    return res.json({ ok: true, count: pipeline.length });
  }

  // ── PULL ALL DATA ← CLOUD ────────────────────────────────────
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

  // ── SYNC PIPELINE → NOTION OUTBOUND TARGETS ──────────────────
  // Pushes all leads from Redis into your Notion Outbound Targets DB
  if (action === 'sync-to-notion' && req.method === 'POST') {
    if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set in Vercel env vars' });

    const pipeline = await redisGet('akira_pipeline') || [];
    if (pipeline.length === 0) return res.json({ ok: true, synced: 0, message: 'No leads in pipeline to sync' });

    // Get existing Notion records to avoid duplicates
    const existing = await notionQuery(NOTION_OUTBOUND_DB);
    const existingNames = new Set(
      (existing.results || []).map(p => p.properties?.['Business Name']?.title?.[0]?.text?.content?.toLowerCase())
    );

    let synced = 0;
    let skipped = 0;
    const errors = [];

    // Process leads in batches to avoid timeout
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const batch = pipeline.slice(offset, offset + limit);

    for (const lead of batch) {
      const name = lead.name || 'Unknown';
      if (existingNames.has(name.toLowerCase())) { skipped++; continue; }

      try {
        const packageText = lead.mercedesPackage
          ? `SUBJECT: ${lead.mercedesPackage.subject || ''}\n\nCOLD EMAIL:\n${lead.mercedesPackage.coldEmail || ''}\n\nCALL SCRIPT:\n${lead.mercedesPackage.callScript || ''}\n\nANGLE: ${lead.mercedesPackage.angle || ''}\n\nNEXT ACTION: ${lead.mercedesPackage.nextAction || ''}`
          : '';

        const properties = {
          'Business Name': { title: [{ text: { content: name } }] },
          'Niche': { select: { name: mapNiche(lead.category) } },
          'City': { rich_text: [{ text: { content: extractCity(lead.address) } }] },
          'State': { rich_text: [{ text: { content: extractState(lead.address) } }] },
          'Outreach Status': { select: { name: mapStageToStatus(lead.stage) } },
          'Lead Score': { select: { name: mapLeadScore(lead) } },
          'Source': { select: { name: 'Google Maps' } },
        };

        // Only add optional fields if they have values
        if (lead.phone) properties['Phone'] = { phone_number: lead.phone };
        if (lead.rating) properties['Google Rating'] = { number: parseFloat(lead.rating) || 0 };
        if (lead.reviewCount) properties['Review Count'] = { number: parseInt(lead.reviewCount) || 0 };
        if (lead.website) {
          properties['Website Status'] = { select: { name: 'Decent' } };
        } else {
          properties['Website Status'] = { select: { name: 'No Website' } };
        }
        if (packageText) {
          properties['Mercedes Output'] = { rich_text: [{ text: { content: packageText.slice(0, 2000) } }] };
        }
        if (lead.touchpoints?.length) {
          const notes = lead.touchpoints.map(t => `${t.date}: ${t.note || t.type}`).join('\n');
          properties['Notes'] = { rich_text: [{ text: { content: notes.slice(0, 2000) } }] };
        }
        if (lead.leadScore === 'hot' || (!lead.website && lead.rating >= 4)) {
          properties['Sequence Day'] = { number: (lead.touchpoints?.length || 0) };
        }

        const result = await notionPost('pages', {
          parent: { database_id: NOTION_OUTBOUND_DB },
          properties
        });

        if (result.id) synced++;
        else errors.push(`${name}: ${JSON.stringify(result).slice(0, 100)}`);

      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }

    return res.json({
      ok: true,
      synced,
      skipped,
      errors: errors.slice(0, 10),
      total: pipeline.length,
      offset,
      limit,
      nextOffset: offset + limit < pipeline.length ? offset + limit : null,
      message: `Synced ${synced} leads to Notion. ${skipped} already existed. ${pipeline.length - offset - batch.length} remaining.`
    });
  }

  // ── SYNC MERCEDES PACKAGES → EXISTING NOTION RECORDS ─────────
  // Updates Notion records with Mercedes-generated outreach packages
  if (action === 'sync-notion-packages' && req.method === 'POST') {
    if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set in Vercel env vars' });

    const pipeline = await redisGet('akira_pipeline') || [];
    const leadsWithPackages = pipeline.filter(l => l.mercedesPackage);

    if (leadsWithPackages.length === 0) {
      return res.json({ ok: true, updated: 0, message: 'No Mercedes packages found to sync' });
    }

    // Get existing Notion records
    const existing = await notionQuery(NOTION_OUTBOUND_DB);
    const notionMap = {};
    for (const page of (existing.results || [])) {
      const name = page.properties?.['Business Name']?.title?.[0]?.text?.content?.toLowerCase();
      if (name) notionMap[name] = page.id;
    }

    let updated = 0;
    const errors = [];

    for (const lead of leadsWithPackages.slice(0, 50)) {
      const name = lead.name?.toLowerCase();
      const pageId = notionMap[name];
      if (!pageId) continue;

      try {
        const pkg = lead.mercedesPackage;
        const packageText = `SUBJECT: ${pkg.subject || ''}\n\nCOLD EMAIL:\n${pkg.coldEmail || ''}\n\nFOLLOW UP 3:\n${pkg.followUp3 || ''}\n\nFOLLOW UP 7:\n${pkg.followUp7 || ''}\n\nCALL SCRIPT:\n${pkg.callScript || ''}\n\nANGLE: ${pkg.angle || ''}\n\nRECOMMENDED PACKAGE: ${pkg.recommendedPackage || ''}\n\nNEXT ACTION: ${pkg.nextAction || ''}`;

        await notionPatch(`pages/${pageId}`, {
          properties: {
            'Mercedes Output': { rich_text: [{ text: { content: packageText.slice(0, 2000) } }] },
            'Lead Score': { select: { name: pkg.leadScore === 'hot' ? 'Hot' : pkg.leadScore === 'warm' ? 'Warm' : 'Cold' } },
            'Outreach Status': { select: { name: mapStageToStatus(lead.stage) } }
          }
        });
        updated++;
      } catch (err) {
        errors.push(`${lead.name}: ${err.message}`);
      }
    }

    return res.json({ ok: true, updated, errors: errors.slice(0, 10), packagesFound: leadsWithPackages.length });
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
    const pipeline = await redisGet('akira_pipeline') || [];
    const withPackages = pipeline.filter(l => l.mercedesPackage).length;
    return res.json({
      status: 'ok',
      lastRun,
      queueSize: queue.length,
      workedToday: worked.length,
      pipelineSize: pipeline.length,
      leadsWithPackages: withPackages
    });
  }

  return res.status(400).json({
    error: 'Unknown action',
    available: ['push-pipeline', 'pull-all', 'clear-queue', 'get-log', 'status', 'sync-to-notion', 'sync-notion-packages']
  });
}
