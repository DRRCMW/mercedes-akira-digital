// Anthropic proxy - injects ANTHROPIC_API_KEY from Vercel env
module.exports = async (req, res) => {
  const ref = req.headers.referer || req.headers.origin || '';
  if (ref && !ref.includes('mercedes-akira-digital')) return res.status(403).json({ error: 'forbidden' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY env var not set in Vercel' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });
    const data = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json');
    return res.send(data);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
};
