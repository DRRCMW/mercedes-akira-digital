 / =================================================================
// MERCEDES — Cloud Sync API v2.2
// FIX: Safe array coercion for all Redis pipeline reads
// =================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mercedes-key, x-notion-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, NOTION_TOKEN, MERCEDES_SECRET } = process.env;
  if (!UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL not configured' });

  const providedKey = req.headers['x-mercedes-key'] || req.query.key;
  const providedNotion = req.headers['x-notion-token'] || req.query.notion_token;
  const action = req.query.action;
  const syncActions = ['sync-to-notion', 'sync-notion-packages', 'notion-status'];
  const isSyncAction = syncActions.includes(action);
  const validMercedesAuth = providedKey === MERCEDES_SECRET;
  const validNotionAuth = providedNotion && (providedNotion === NOTION_TOKEN ||
    providedNotion.startsWith('ntn_') || providedNotion.startsWith('secret_'));
  if (!validMercedesAuth && !(isSyncAction && validNotionAuth)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const activeNotionToken = providedNotion || NOTION_TOKEN;
  const NOTION_OUTBOUND_DB = 'a3d2c021b2cc4aed983b10886908824a';

  function ensureArr(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    return [];
  }

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

  async function notionPost(endpoint, body, token) {
    const r = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  async function notionPatch(endpoint, body, token) {
    const r = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  async function notionQuery(databaseId, token) {
    const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    return r.json();
  }

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

  function mapStage(stage) {
    const map = { 'new':'Not Started','contacted':'Day 1 Sent','follow-up':'Day 3 Sent','responded':'Responded','meeting':'Meeting Booked','proposal':'Proposal Sent','closed':'Closed Won','lost':'Closed Lost' };
    return map[stage] || 'Not Started';
  }

  function extractCity(address) {
    if (!address) return '';
    const parts = address.split(',');
    return parts.length >= 3 ? parts[parts.length - 3]?.trim() || '' : parts[0]?.trim() || '';
  }

  function extractState(address) {
    if (!address) return '';
    const parts = address.split(',');
    if (parts.length >= 2) { const s = parts[parts.length - 2]?.trim() || ''; return s.split(' ')[0] || ''; }
    return '';
  }

  if (action === 'status' && req.method === 'GET') {
    const [lastRun, rawQueue, rawPipeline] = await Promise.all([
      redisGet('mercedes_last_run'), redisGet('mercedes_queue'), redisGet('akira_pipeline')
    ]);
    const queue = ensureArr(rawQueue);
    const pipeline = ensureArr(rawPipeline);
    const today = new Date().toDateString();
    const worked = ensureArr(await redisGet(`worked_${today}`));
    return res.json({ status:'ok', lastRun, queueSize: queue.length, workedToday: worked.length, pipelineSize: pipeline.length, leadsWithPackages: pipeline.filter(l => l && l.mercedesPackage).length });
  }

  if (action === 'notion-status') {
    try {
      const r = await fetch('https://api.notion.com/v1/users/me', {
        headers: { 'Authorization': `Bearer ${activeNotionToken}`, 'Notion-Version': '2022-06-28' }
      });
      const user = await r.json();
      const pipeline = ensureArr(await redisGet('akira_pipeline'));
      const queue = ensureArr(await redisGet('mercedes_queue'));
      return res.json({ notionConnected: !!user.id, notionUser: user.name || user.id, pipelineInRedis: pipeline.length, leadsWithPackages: pipeline.filter(l => l && l.mercedesPackage).length, queueSize: queue.length });
    } catch (e) { return res.json({ error: e.message }); }
  }

  if (action === 'sync-to-notion' && req.method === 'POST') {
    const pipeline = ensureArr(await redisGet('akira_pipeline'));
    if (!pipeline.length) return res.json({ ok: true, synced: 0, message: 'No leads in Redis pipeline' });
    const existing = await notionQuery(NOTION_OUTBOUND_DB, activeNotionToken);
    const existingNames = new Set((existing.results || []).map(p => p.properties?.['Business Name']?.title?.[0]?.text?.content?.toLowerCase()));
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 50;
    const batch = pipeline.slice(offset, offset + limit);
    let synced = 0, skipped = 0;
    const errors = [];
    for (const lead of batch) {
      const name = lead.name || 'Unknown';
      if (existingNames.has(name.toLowerCase())) { skipped++; continue; }
      try {
        const pkg = lead.mercedesPackage;
        const packageText = pkg ? `SUBJECT: ${pkg.subject||''}\nCOLD EMAIL:\n${pkg.coldEmail||''}\nCALL SCRIPT:\n${pkg.callScript||''}\nANGLE: ${pkg.angle||''}\nNEXT ACTION: ${pkg.nextAction||''}` : '';
        const properties = {
          'Business Name': { title: [{ text: { content: name } }] },
          'Niche': { select: { name: mapNiche(lead.category) } },
          'City': { rich_text: [{ text: { content: extractCity(lead.address) } }] },
          'State': { rich_text: [{ text: { content: extractState(lead.address) } }] },
          'Outreach Status': { select: { name: mapStage(lead.stage) } },
          'Lead Score': { select: { name: !lead.website && lead.rating >= 4 ? 'Hot' : !lead.website ? 'Warm' : 'Cold' } },
          'Website Status': { select: { name: lead.website ? 'Decent' : 'No Website' } },
          'Source': { select: { name: 'Google Maps' } },
        };
        if (lead.phone) properties['Phone'] = { phone_number: lead.phone };
        if (lead.rating) properties['Google Rating'] = { number: parseFloat(lead.rating) || 0 };
        if (lead.reviewCount) properties['Review Count'] = { number: parseInt(lead.reviewCount) || 0 };
        if (packageText) properties['Mercedes Output'] = { rich_text: [{ text: { content: packageText.slice(0, 2000) } }] };
        if (lead.touchpoints?.length) properties['Notes'] = { rich_text: [{ text: { content: lead.touchpoints.map(t => `${t.date}: ${t.note||t.type}`).join('\n').slice(0, 2000) } }] };
        const result = await notionPost('pages', { parent: { database_id: NOTION_OUTBOUND_DB }, properties }, activeNotionToken);
        if (result.id) synced++; else errors.push(`${name}: ${JSON.stringify(result).slice(0, 100)}`);
      } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    return res.json({ ok: true, synced, skipped, errors: errors.slice(0, 10), total: pipeline.length, offset, limit, nextOffset: offset + limit < pipeline.length ? offset + limit : null, message: `Synced ${synced} of ${batch.length} leads.` });
  }
  if (action === 'sync-notion-packages' && req.method === 'POST') {
    const pipeline = ensureArr(await redisGet('akira_pipeline'));
    const leadsWithPackages = pipeline.filter(l => l && l.mercedesPackage);
    if (!leadsWithPackages.length) return res.json({ ok: true, updated: 0, message: 'No packages to sync' });
    const existing = await notionQuery(NOTION_OUTBOUND_DB, activeNotionToken);
    const notionMap = {};
    for (const page of (existing.results || [])) {
      const name = page.properties?.['Business Name']?.title?.[0]?.text?.content?.toLowerCase();
      if (name) notionMap[name] = page.id;
    }
    let updated = 0;
    for (const lead of leadsWithPackages.slice(0, 50)) {
      const pageId = notionMap[lead.name?.toLowerCase()];
      if (!pageId) continue;
      try {
        const pkg = lead.mercedesPackage;
        const text = `SUBJECT: ${pkg.subject||''}\nCOLD EMAIL:\n${pkg.coldEmail||''}\nFOLLOW UP 3:\n${pkg.followUp3||''}\nFOLLOW UP 7:\n${pkg.followUp7||''}\nCALL SCRIPT:\n${pkg.callScript||''}\nANGLE: ${pkg.angle||''}\nRECOMMENDED: ${pkg.recommendedPackage||''}\nNEXT ACTION: ${pkg.nextAction||''}`;
        await notionPatch(`pages/${pageId}`, { properties: { 'Mercedes Output': { rich_text: [{ text: { content: text.slice(0, 2000) } }] }, 'Lead Score': { select: { name: pkg.leadScore === 'hot' ? 'Hot' : pkg.leadScore === 'warm' ? 'Warm' : 'Cold' } }, 'Outreach Status': { select: { name: mapStage(lead.stage) } } } }, activeNotionToken);
        updated++;
      } catch (e) { /* continue */ }
    }
    return res.json({ ok: true, updated, packagesFound: leadsWithPackages.length });
  }

  if (!validMercedesAuth) return res.status(401).json({ error: 'Unauthorized for this action' });

  if (action === 'push-pipeline' && req.method === 'POST') {
    const pipeline = req.body;
    if (!Array.isArray(pipeline)) return res.status(400).json({ error: 'Pipeline must be an array' });
    await redisSet('akira_pipeline', pipeline);
    return res.json({ ok: true, count: pipeline.length });
  }

  // Notion leads: fetch all 312 leads from Notion Prospect Finder DB
  if (action === 'notion-leads' && req.method === 'GET') {
    const NOTION_TOKEN = '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';
    const DB_ID = 'a3d2c021b2cc4aed983b10886908824a';
    try {
      const all = [];
      let cursor = null;
      let page = 0;
      do {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch('https://api.notion.com/v1/databases/' + DB_ID + '/query', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + NOTION_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const d = await r.json();
        all.push(...(d.results || []));
        cursor = d.has_more ? d.next_cursor : null;
        page++;
      } while (cursor && page < 20);
      const leads = all.map((rec, i) => {
        const p = rec.properties || {};
        const name = (p['Business Name']?.title || [])[0]?.plain_text || '';
        const phone = p['Phone']?.phone_number || '';
        const city = (p['City']?.rich_text || [])[0]?.plain_text || 'Los Angeles';
        const state = (p['State']?.rich_text || [])[0]?.plain_text || 'CA';
        const rating = p['Google Rating']?.number || 4.5;
        const reviews = p['Review Count']?.number || 0;
        const tier = p['Lead Score']?.select?.name || 'Hot';
        const niche = p['Niche']?.select?.name || 'Other';
        const outreach = p['Outreach Status']?.select?.name || 'Not Started';
        const website = p['Website Status']?.select?.name || 'No Website';
        const addedAt = p['Added']?.created_time || rec.created_time || '';
        let stage = 'new';
        if (['Day 1 Sent','Day 3 Sent','Day 7 Sent','Day 14 Sent','Day 21 Sent'].includes(outreach)) stage = 'contacted';
        else if (outreach === 'Responded' || outreach === 'Meeting Booked') stage = 'meeting';
        else if (outreach === 'Closed Won') stage = 'won';
        else if (outreach === 'Closed Lost') stage = 'lost';
        return { place_id: 'notion-' + rec.id.replace(/-/g,''), notion_id: rec.id, name, phone, address: city + ', ' + state + ', USA', city, state, rating, reviews, score: Math.min(100, Math.round(rating * 10 + (reviews > 20 ? 10 : 0))), tier, niche, reason: website, angle: 'Notion Prospect Finder', stage, touchpoints: [], nextFollowup: null, addedAt, uid: new Date(addedAt).getTime() + i };
      });
      return res.status(200).json({ total: leads.length, pages: page, leads });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'pull-all' && req.method === 'GET') {
    const today = new Date().toDateString();
    const [rawQueue, rawPipeline, rawWorked, lastRun, log] = await Promise.all([
      redisGet('mercedes_queue'), redisGet('akira_pipeline'),
      redisGet(`worked_${today}`), redisGet('mercedes_last_run'), redisGet('mercedes_log')
    ]);
    return res.json({ queue: ensureArr(rawQueue), pipeline: ensureArr(rawPipeline), workedToday: ensureArr(rawWorked), lastRun: lastRun||null, log: ensureArr(log).slice(0,50) });
  }

  if (action === 'clear-queue' && req.method === 'POST') {
    await redisSet('mercedes_queue', []);
    return res.json({ ok: true });
  }

  if (action === 'get-log' && req.method === 'GET') {
    const log = ensureArr(await redisGet('mercedes_log'));
    return res.json({ log: log.slice(0, 100) });
  }

  
  // ---- NOTION IMPORT: Pull ALL leads from Notion → Redis ----
  if (action === 'notion-import' && req.method === 'POST') {
    const importToken = process.env.NOTION_TOKEN || NOTION_TOKEN || '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';
    const allRecords = [];
    let cursor;
    let page = 0;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const data = await notionPost('databases/' + NOTION_OUTBOUND_DB + '/query', body, importToken);
      if (!data || data.object === 'error') break;
      allRecords.push(...(data.results || []));
      cursor = data.has_more ? data.next_cursor : null;
      page++;
    } while (cursor && page < 10);
    const pipeline = allRecords.map((record, i) => {
      const p = record.properties || {};
      const name = p['Business Name']?.title?.[0]?.plain_text || 'Unknown';
      const phone = p['Phone']?.phone_number || '';
      const email = p['Email']?.email || '';
      const city = p['City']?.rich_text?.[0]?.plain_text || 'Los Angeles';
      const state = p['State']?.rich_text?.[0]?.plain_text || 'CA';
      const rating = p['Google Rating']?.number || 4.5;
      const reviews = p['Review Count']?.number || 10;
      const tier = p['Lead Score']?.select?.name || 'Hot';
      const s = p['Outreach Status']?.select?.name;
      const stageMap = {'Not Started':'new','Day 1 Sent':'contacted','Day 3 Sent':'contacted','Day 7 Sent':'contacted','Day 14 Sent':'contacted','Day 21 Sent':'contacted','Responded':'responded','Meeting Booked':'meeting','Proposal Sent':'proposal','Closed Won':'won','Closed Lost':'lost','Unsubscribed':'lost'};
      const stage = stageMap[s] || 'new';
      const niche = p['Niche']?.select?.name || 'Other';
      const websiteStatus = p['Website Status']?.select?.name || 'No Website';
      const score = Math.round(rating * 10 + (reviews > 20 ? 10 : 0));
      const addedAt = record.created_time || new Date().toISOString();
      return { place_id: 'notion-' + record.id.replace(/-/g, ''), name, phone, email, address: city + ', ' + state + ', USA', city, state, rating, reviews, score, tier, stage, niche, website: null, reason: websiteStatus, angle: niche + ' in ' + city + ' — no website', touchpoints: [], nextFollowup: null, addedAt, uid: new Date(addedAt).getTime() + i };
    });
    if (pipeline.length === 0) return res.json({ ok: false, count: 0, pages: page, error: 'Notion returned 0 records — pipeline not overwritten for safety', notionToken: importToken?.slice(0,20) });
    await redisSet('akira_pipeline', pipeline);
    return res.json({ ok: true, count: pipeline.length, pages: page, sample: pipeline.slice(0, 3).map(l => l.name), message: 'Imported ' + pipeline.length + ' leads from Notion Prospect Finder.' });
  }

  // ---- NOTION DEBUG: Test Notion connection ----
  if (action === 'notion-debug' && req.method === 'GET') {
    const testToken = req.query.token || req.headers['x-notion-token'] || activeNotionToken;
    try {
      const r1 = await fetch('https://api.notion.com/v1/users/me', {
        headers: { 'Authorization': 'Bearer ' + testToken, 'Notion-Version': '2022-06-28' }
      });
      const userRaw = await r1.json();
      const r2 = await fetch('https://api.notion.com/v1/databases/a3d2c021b2cc4aed983b10886908824a/query', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + testToken, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_size: 5 })
      });
      const dbRaw = await r2.json();
      return res.json({ tokenUsed: testToken?.slice(0,20), userStatus: r1.status, userResponse: userRaw, dbStatus: r2.status, dbResultsCount: dbRaw?.results?.length, dbError: dbRaw?.message, dbObject: dbRaw?.object });
    } catch(e) { return res.json({ error: e.message }); }
  }
  if (action === 'notion-pull') {
    try {
      const NT = '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';
      const DID = 'a3d2c021b2cc4aed983b10886908824a';
      const all = [];
      let cursor = null;
      let page = 0;
      do {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const nr = await fetch('https://api.notion.com/v1/databases/' + DID + '/query', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + NT, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const nd = await nr.json();
        all.push(...(nd.results || []));
        cursor = nd.has_more ? nd.next_cursor : null;
        page++;
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
        const addedAt = p['Added']?.created_time || rec.created_time || '';
        let stage = 'new';
        if (['Day 1 Sent','Day 3 Sent','Day 7 Sent','Day 14 Sent','Day 21 Sent'].includes(outreach)) stage = 'contacted';
        else if (['Responded','Meeting Booked'].includes(outreach)) stage = 'meeting';
        else if (outreach === 'Closed Won') stage = 'won';
        else if (outreach === 'Closed Lost') stage = 'lost';
        return { place_id: 'notion-' + rec.id.replace(/-/g,''), notion_id: rec.id, name, phone, address: city + ', ' + state + ', USA', rating, reviews, score: Math.min(100, Math.round(rating*10+(reviews>20?10:0))), tier, reason: website, angle: 'Notion Prospect Finder', stage, touchpoints: [], nextFollowup: null, addedAt, uid: new Date(addedAt).getTime() + i };
      });
      return res.json({ total: leads.length, pages: page, leads });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }


return res.status(400).json({ error: 'Unknown action', available: ['push-pipeline','pull-all','clear-queue','get-log','status','sync-to-notion','sync-notion-packages','notion-status'] });
}
// =================================================================
// MERCEDES — Cloud Sync API v2.2
// FIX: Safe array coercion for all Redis pipeline reads
// =================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mercedes-key, x-notion-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, NOTION_TOKEN, MERCEDES_SECRET } = process.env;
  if (!UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL not configured' });

  const providedKey = req.headers['x-mercedes-key'] || req.query.key;
  const providedNotion = req.headers['x-notion-token'] || req.query.notion_token;
  const action = req.query.action;
  const syncActions = ['sync-to-notion', 'sync-notion-packages', 'notion-status'];
  const isSyncAction = syncActions.includes(action);
  const validMercedesAuth = providedKey === MERCEDES_SECRET;
  const validNotionAuth = providedNotion && (providedNotion === NOTION_TOKEN ||
    providedNotion.startsWith('ntn_') || providedNotion.startsWith('secret_'));
  if (!validMercedesAuth && !(isSyncAction && validNotionAuth)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const activeNotionToken = providedNotion || NOTION_TOKEN;
  const NOTION_OUTBOUND_DB = 'a3d2c021b2cc4aed983b10886908824a';

  function ensureArr(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    return [];
  }

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

  async function notionPost(endpoint, body, token) {
    const r = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  async function notionPatch(endpoint, body, token) {
    const r = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  async function notionQuery(databaseId, token) {
    const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    return r.json();
  }

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

  function mapStage(stage) {
    const map = { 'new':'Not Started','contacted':'Day 1 Sent','follow-up':'Day 3 Sent','responded':'Responded','meeting':'Meeting Booked','proposal':'Proposal Sent','closed':'Closed Won','lost':'Closed Lost' };
    return map[stage] || 'Not Started';
  }

  function extractCity(address) {
    if (!address) return '';
    const parts = address.split(',');
    return parts.length >= 3 ? parts[parts.length - 3]?.trim() || '' : parts[0]?.trim() || '';
  }

  function extractState(address) {
    if (!address) return '';
    const parts = address.split(',');
    if (parts.length >= 2) { const s = parts[parts.length - 2]?.trim() || ''; return s.split(' ')[0] || ''; }
    return '';
  }

  if (action === 'status' && req.method === 'GET') {
    const [lastRun, rawQueue, rawPipeline] = await Promise.all([
      redisGet('mercedes_last_run'), redisGet('mercedes_queue'), redisGet('akira_pipeline')
    ]);
    const queue = ensureArr(rawQueue);
    const pipeline = ensureArr(rawPipeline);
    const today = new Date().toDateString();
    const worked = ensureArr(await redisGet(`worked_${today}`));
    return res.json({ status:'ok', lastRun, queueSize: queue.length, workedToday: worked.length, pipelineSize: pipeline.length, leadsWithPackages: pipeline.filter(l => l && l.mercedesPackage).length });
  }

  if (action === 'notion-status') {
    try {
      const r = await fetch('https://api.notion.com/v1/users/me', {
        headers: { 'Authorization': `Bearer ${activeNotionToken}`, 'Notion-Version': '2022-06-28' }
      });
      const user = await r.json();
      const pipeline = ensureArr(await redisGet('akira_pipeline'));
      const queue = ensureArr(await redisGet('mercedes_queue'));
      return res.json({ notionConnected: !!user.id, notionUser: user.name || user.id, pipelineInRedis: pipeline.length, leadsWithPackages: pipeline.filter(l => l && l.mercedesPackage).length, queueSize: queue.length });
    } catch (e) { return res.json({ error: e.message }); }
  }

  if (action === 'sync-to-notion' && req.method === 'POST') {
    const pipeline = ensureArr(await redisGet('akira_pipeline'));
    if (!pipeline.length) return res.json({ ok: true, synced: 0, message: 'No leads in Redis pipeline' });
    const existing = await notionQuery(NOTION_OUTBOUND_DB, activeNotionToken);
    const existingNames = new Set((existing.results || []).map(p => p.properties?.['Business Name']?.title?.[0]?.text?.content?.toLowerCase()));
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 50;
    const batch = pipeline.slice(offset, offset + limit);
    let synced = 0, skipped = 0;
    const errors = [];
    for (const lead of batch) {
      const name = lead.name || 'Unknown';
      if (existingNames.has(name.toLowerCase())) { skipped++; continue; }
      try {
        const pkg = lead.mercedesPackage;
        const packageText = pkg ? `SUBJECT: ${pkg.subject||''}\nCOLD EMAIL:\n${pkg.coldEmail||''}\nCALL SCRIPT:\n${pkg.callScript||''}\nANGLE: ${pkg.angle||''}\nNEXT ACTION: ${pkg.nextAction||''}` : '';
        const properties = {
          'Business Name': { title: [{ text: { content: name } }] },
          'Niche': { select: { name: mapNiche(lead.category) } },
          'City': { rich_text: [{ text: { content: extractCity(lead.address) } }] },
          'State': { rich_text: [{ text: { content: extractState(lead.address) } }] },
          'Outreach Status': { select: { name: mapStage(lead.stage) } },
          'Lead Score': { select: { name: !lead.website && lead.rating >= 4 ? 'Hot' : !lead.website ? 'Warm' : 'Cold' } },
          'Website Status': { select: { name: lead.website ? 'Decent' : 'No Website' } },
          'Source': { select: { name: 'Google Maps' } },
        };
        if (lead.phone) properties['Phone'] = { phone_number: lead.phone };
        if (lead.rating) properties['Google Rating'] = { number: parseFloat(lead.rating) || 0 };
        if (lead.reviewCount) properties['Review Count'] = { number: parseInt(lead.reviewCount) || 0 };
        if (packageText) properties['Mercedes Output'] = { rich_text: [{ text: { content: packageText.slice(0, 2000) } }] };
        if (lead.touchpoints?.length) properties['Notes'] = { rich_text: [{ text: { content: lead.touchpoints.map(t => `${t.date}: ${t.note||t.type}`).join('\n').slice(0, 2000) } }] };
        const result = await notionPost('pages', { parent: { database_id: NOTION_OUTBOUND_DB }, properties }, activeNotionToken);
        if (result.id) synced++; else errors.push(`${name}: ${JSON.stringify(result).slice(0, 100)}`);
      } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    return res.json({ ok: true, synced, skipped, errors: errors.slice(0, 10), total: pipeline.length, offset, limit, nextOffset: offset + limit < pipeline.length ? offset + limit : null, message: `Synced ${synced} of ${batch.length} leads.` });
  }
  if (action === 'sync-notion-packages' && req.method === 'POST') {
    const pipeline = ensureArr(await redisGet('akira_pipeline'));
    const leadsWithPackages = pipeline.filter(l => l && l.mercedesPackage);
    if (!leadsWithPackages.length) return res.json({ ok: true, updated: 0, message: 'No packages to sync' });
    const existing = await notionQuery(NOTION_OUTBOUND_DB, activeNotionToken);
    const notionMap = {};
    for (const page of (existing.results || [])) {
      const name = page.properties?.['Business Name']?.title?.[0]?.text?.content?.toLowerCase();
      if (name) notionMap[name] = page.id;
    }
    let updated = 0;
    for (const lead of leadsWithPackages.slice(0, 50)) {
      const pageId = notionMap[lead.name?.toLowerCase()];
      if (!pageId) continue;
      try {
        const pkg = lead.mercedesPackage;
        const text = `SUBJECT: ${pkg.subject||''}\nCOLD EMAIL:\n${pkg.coldEmail||''}\nFOLLOW UP 3:\n${pkg.followUp3||''}\nFOLLOW UP 7:\n${pkg.followUp7||''}\nCALL SCRIPT:\n${pkg.callScript||''}\nANGLE: ${pkg.angle||''}\nRECOMMENDED: ${pkg.recommendedPackage||''}\nNEXT ACTION: ${pkg.nextAction||''}`;
        await notionPatch(`pages/${pageId}`, { properties: { 'Mercedes Output': { rich_text: [{ text: { content: text.slice(0, 2000) } }] }, 'Lead Score': { select: { name: pkg.leadScore === 'hot' ? 'Hot' : pkg.leadScore === 'warm' ? 'Warm' : 'Cold' } }, 'Outreach Status': { select: { name: mapStage(lead.stage) } } } }, activeNotionToken);
        updated++;
      } catch (e) { /* continue */ }
    }
    return res.json({ ok: true, updated, packagesFound: leadsWithPackages.length });
  }

  if (!validMercedesAuth) return res.status(401).json({ error: 'Unauthorized for this action' });

  if (action === 'push-pipeline' && req.method === 'POST') {
    const pipeline = req.body;
    if (!Array.isArray(pipeline)) return res.status(400).json({ error: 'Pipeline must be an array' });
    await redisSet('akira_pipeline', pipeline);
    return res.json({ ok: true, count: pipeline.length });
  }

  // Notion leads: fetch all 312 leads from Notion Prospect Finder DB
  if (action === 'notion-leads' && req.method === 'GET') {
    const NOTION_TOKEN = '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';
    const DB_ID = 'a3d2c021b2cc4aed983b10886908824a';
    try {
      const all = [];
      let cursor = null;
      let page = 0;
      do {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch('https://api.notion.com/v1/databases/' + DB_ID + '/query', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + NOTION_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const d = await r.json();
        all.push(...(d.results || []));
        cursor = d.has_more ? d.next_cursor : null;
        page++;
      } while (cursor && page < 20);
      const leads = all.map((rec, i) => {
        const p = rec.properties || {};
        const name = (p['Business Name']?.title || [])[0]?.plain_text || '';
        const phone = p['Phone']?.phone_number || '';
        const city = (p['City']?.rich_text || [])[0]?.plain_text || 'Los Angeles';
        const state = (p['State']?.rich_text || [])[0]?.plain_text || 'CA';
        const rating = p['Google Rating']?.number || 4.5;
        const reviews = p['Review Count']?.number || 0;
        const tier = p['Lead Score']?.select?.name || 'Hot';
        const niche = p['Niche']?.select?.name || 'Other';
        const outreach = p['Outreach Status']?.select?.name || 'Not Started';
        const website = p['Website Status']?.select?.name || 'No Website';
        const addedAt = p['Added']?.created_time || rec.created_time || '';
        let stage = 'new';
        if (['Day 1 Sent','Day 3 Sent','Day 7 Sent','Day 14 Sent','Day 21 Sent'].includes(outreach)) stage = 'contacted';
        else if (outreach === 'Responded' || outreach === 'Meeting Booked') stage = 'meeting';
        else if (outreach === 'Closed Won') stage = 'won';
        else if (outreach === 'Closed Lost') stage = 'lost';
        return { place_id: 'notion-' + rec.id.replace(/-/g,''), notion_id: rec.id, name, phone, address: city + ', ' + state + ', USA', city, state, rating, reviews, score: Math.min(100, Math.round(rating * 10 + (reviews > 20 ? 10 : 0))), tier, niche, reason: website, angle: 'Notion Prospect Finder', stage, touchpoints: [], nextFollowup: null, addedAt, uid: new Date(addedAt).getTime() + i };
      });
      return res.status(200).json({ total: leads.length, pages: page, leads });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'pull-all' && req.method === 'GET') {
    const today = new Date().toDateString();
    const [rawQueue, rawPipeline, rawWorked, lastRun, log] = await Promise.all([
      redisGet('mercedes_queue'), redisGet('akira_pipeline'),
      redisGet(`worked_${today}`), redisGet('mercedes_last_run'), redisGet('mercedes_log')
    ]);
    return res.json({ queue: ensureArr(rawQueue), pipeline: ensureArr(rawPipeline), workedToday: ensureArr(rawWorked), lastRun: lastRun||null, log: ensureArr(log).slice(0,50) });
  }

  if (action === 'clear-queue' && req.method === 'POST') {
    await redisSet('mercedes_queue', []);
    return res.json({ ok: true });
  }

  if (action === 'get-log' && req.method === 'GET') {
    const log = ensureArr(await redisGet('mercedes_log'));
    return res.json({ log: log.slice(0, 100) });
  }

  
  // ---- NOTION IMPORT: Pull ALL leads from Notion → Redis ----
  if (action === 'notion-import' && req.method === 'POST') {
    const importToken = process.env.NOTION_TOKEN || NOTION_TOKEN || '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';
    const allRecords = [];
    let cursor;
    let page = 0;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const data = await notionPost('databases/' + NOTION_OUTBOUND_DB + '/query', body, importToken);
      if (!data || data.object === 'error') break;
      allRecords.push(...(data.results || []));
      cursor = data.has_more ? data.next_cursor : null;
      page++;
    } while (cursor && page < 10);
    const pipeline = allRecords.map((record, i) => {
      const p = record.properties || {};
      const name = p['Business Name']?.title?.[0]?.plain_text || 'Unknown';
      const phone = p['Phone']?.phone_number || '';
      const email = p['Email']?.email || '';
      const city = p['City']?.rich_text?.[0]?.plain_text || 'Los Angeles';
      const state = p['State']?.rich_text?.[0]?.plain_text || 'CA';
      const rating = p['Google Rating']?.number || 4.5;
      const reviews = p['Review Count']?.number || 10;
      const tier = p['Lead Score']?.select?.name || 'Hot';
      const s = p['Outreach Status']?.select?.name;
      const stageMap = {'Not Started':'new','Day 1 Sent':'contacted','Day 3 Sent':'contacted','Day 7 Sent':'contacted','Day 14 Sent':'contacted','Day 21 Sent':'contacted','Responded':'responded','Meeting Booked':'meeting','Proposal Sent':'proposal','Closed Won':'won','Closed Lost':'lost','Unsubscribed':'lost'};
      const stage = stageMap[s] || 'new';
      const niche = p['Niche']?.select?.name || 'Other';
      const websiteStatus = p['Website Status']?.select?.name || 'No Website';
      const score = Math.round(rating * 10 + (reviews > 20 ? 10 : 0));
      const addedAt = record.created_time || new Date().toISOString();
      return { place_id: 'notion-' + record.id.replace(/-/g, ''), name, phone, email, address: city + ', ' + state + ', USA', city, state, rating, reviews, score, tier, stage, niche, website: null, reason: websiteStatus, angle: niche + ' in ' + city + ' — no website', touchpoints: [], nextFollowup: null, addedAt, uid: new Date(addedAt).getTime() + i };
    });
    if (pipeline.length === 0) return res.json({ ok: false, count: 0, pages: page, error: 'Notion returned 0 records — pipeline not overwritten for safety', notionToken: importToken?.slice(0,20) });
    await redisSet('akira_pipeline', pipeline);
    return res.json({ ok: true, count: pipeline.length, pages: page, sample: pipeline.slice(0, 3).map(l => l.name), message: 'Imported ' + pipeline.length + ' leads from Notion Prospect Finder.' });
  }

  // ---- NOTION DEBUG: Test Notion connection ----
  if (action === 'notion-debug' && req.method === 'GET') {
    const testToken = req.query.token || req.headers['x-notion-token'] || activeNotionToken;
    try {
      const r1 = await fetch('https://api.notion.com/v1/users/me', {
        headers: { 'Authorization': 'Bearer ' + testToken, 'Notion-Version': '2022-06-28' }
      });
      const userRaw = await r1.json();
      const r2 = await fetch('https://api.notion.com/v1/databases/a3d2c021b2cc4aed983b10886908824a/query', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + testToken, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_size: 5 })
      });
      const dbRaw = await r2.json();
      return res.json({ tokenUsed: testToken?.slice(0,20), userStatus: r1.status, userResponse: userRaw, dbStatus: r2.status, dbResultsCount: dbRaw?.results?.length, dbError: dbRaw?.message, dbObject: dbRaw?.object });
    } catch(e) { return res.json({ error: e.message }); }
  }

return res.status(400).json({ error: 'Unknown action', available: ['push-pipeline','pull-all','clear-queue','get-log','status','sync-to-notion','sync-notion-packages','notion-status'] });
}
