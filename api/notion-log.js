// /api/notion-log â writes agent activity to Notion Agent Messages DB
// Called by: dashboard when processing packages, Make backup scenario
// Falls back gracefully if token is missing/expired â never breaks sales flow
export const config = { maxDuration: 15 };

const AGENT_MESSAGES_DB = '4f1024315ab2460d977ce218d841c92d';
const NOTION_VERSION = '2022-06-28';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mercedes-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const provided = req.headers['x-mercedes-key'] || req.query.key || (req.body && req.body.key);
  if (provided !== process.env.MERCEDES_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    const token = process.env.NOTION_TOKEN;
    if (!token) return res.status(200).json({ status: 'no_token', notion: false });
    try {
      const r = await fetch('https://api.notion.com/v1/users/me', { headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': NOTION_VERSION } });
      const d = await r.json();
      return res.status(200).json({ status: r.ok ? 'ok' : 'error', notion: r.ok, user: r.ok ? d.name : null, error: r.ok ? null : d.message });
    } catch (e) { return res.status(200).json({ status: 'error', notion: false, error: String(e) }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(200).json({ logged: false, reason: 'NOTION_TOKEN not set' });
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
  const msg = body.message || body.subject || body.text || 'Agent activity';
  const fromAgent = body.fromAgent || body.agentId || 'Sales Agent';
  const toAgent = body.toAgent || 'Founder';
  const type = body.type || 'Update';
  const status = body.status || 'Done';
  const priority = body.priority || 'Normal';
  const clientName = body.clientName || body.leadName || body.name || '';
  const projectStage = body.projectStage || body.stage || '';
  const payload = body.payload || body.data ? JSON.stringify(body.payload || body.data || {}) : JSON.stringify({ source: fromAgent, ts: new Date().toISOString() });
  const validFrom = ['Sales Agent','Web Builder','Client Success','Growth Agent','Ops Agent','SEO Agent','System'];
  const validTo = ['Sales Agent','Web Builder','Client Success','Growth Agent','Ops Agent','SEO Agent','Founder'];
  const validType = ['Handoff','Alert','Update','Request','Report'];
  const validStatus = ['Pending','Processing','Done','Failed'];
  const validPriority = ['High','Normal','Low'];
  const properties = {
    Message: { title: [{ text: { content: msg.slice(0,2000) } }] },
    'From Agent': vlalidFrom.includes(fromAgent) ? { select: { name: fromAgent } } : { select: { name: 'System' } },
    'To Agent': validTo.includes(toAgent) ? { select: { name: toAgent } } : undefined,
    Type: validType.includes(type) ? { select: { name: type } } : { select: { name: 'Update' } },
    Status: validStatus.includes(status) ? { select: { name: status } } : { select: { name: 'Done' } },
    Priority: validPriority.includes(priority) ? { select: { name: priority } } : { select: { name: 'Normal' } },
  };
  if (clientName) properties['Client Name'] = { rich_text: [{ text: { content: clientName.slice(0,200) } }] };
  if (projectStage) properties['Project Stage'] = { rich_text: [{ text: { content: projectStage.slice(0,200) } }] };
  if (payload) properties['Payload'] = { rich_text: [{ text: { content: payload.slice(0,2000) } }] };
  Object.keys(properties).forEach(k => properties[k] === undefined && delete properties[k]);
  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: { database_id: AGENT_MESSAGES_DB }, properties })
    });
    const data = await r.json();
    return r.ok
      ? res.status(200).json({ logged: true, notionId: data.id, url: data.url })
      : res.status(200).json({ logged: false, notionError: data.message });
  } catch (e) { return res.status(200).json({ logged: false, error: String(e) }); }
}

