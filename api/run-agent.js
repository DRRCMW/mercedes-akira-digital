// Agent runner - forwards to the Make router, injecting NOTION_TOKEN server-side
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = Object.assign({}, req.body || {});
  body.notion_token = process.env.NOTION_TOKEN || '';
  try {
    const r = await fetch('https://hook.us2.make.com/7vorb5d3yqes4navi3h3f1sde3l9g2na', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const t = await r.text();
    return res.status(r.status).send(t);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
};
