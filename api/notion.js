// /api/notion â Notion proxy for the Akira Digital command center
// Strategy: Uses NOTION_TOKEN env var if set, OR accepts x-notion-token header from dashboard
// This way the dashboard's localStorage token always works even if env var is stale
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-notion-token, x-mercedes-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Security: only accept requests from the dashboard or with a valid mercedes key
  const ref = req.headers.referer || req.headers.origin || '';
  const mercKey = req.headers['x-mercedes-key'] || req.query.key;
  const isFromDashboard = ref.includes('mercedes-akira-digital') || ref.includes('localhost');
  if (!isFromDashboard && mercKey !== process.env.MERCEDES_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const target = req.query.url || '';
  if (!target.startsWith('https://api.notion.com/')) return res.status(400).json({ error: 'bad target' });

  // Token priority: 1) x-notion-token header from dashboard, 2) NOTION_TOKEN env var
  const token = req.headers['x-notion-token'] || process.env.NOTION_TOKEN;
  if (!token) return res.status(500).json({ error: 'No Notion token â set NOTION_TOKEN in Vercel or paste your token in the dashboard settings' });

  try {
    const r = await fetch(target, {
      method: req.method,
      headers: { 
        'Authorization': 'Bearer ' + token, 
        'Notion-Version': '2022-06-28', 
        'Content-Type': 'application/json' 
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {})
    });
    const data = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json');
    return res.send(data);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
};

