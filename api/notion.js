// Notion proxy - injects NOTION_TOKEN from Vercel env so the dashboard works on any browser
module.exports = async (req, res) => {
  const ref = req.headers.referer || req.headers.origin || '';
  if (ref && !ref.includes('mercedes-akira-digital')) return res.status(403).json({ error: 'forbidden' });
  const target = req.query.url || '';
  if (!target.startsWith('https://api.notion.com/')) return res.status(400).json({ error: 'bad target' });
  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(500).json({ error: 'NOTION_TOKEN env var not set in Vercel' });
  try {
    const r = await fetch(target, {
      method: req.method,
      headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {})
    });
    const data = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json');
    return res.send(data);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
};
