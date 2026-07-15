// api/chat.js — shared team chat for Akira Command Center.
// Backed by the same Upstash Redis. Only signed-in users (valid session token
// from /api/auth) can read or post. Messages are capped to the most recent 200.
const RU = process.env.UPSTASH_REDIS_REST_URL;
const RT = process.env.UPSTASH_REDIS_REST_TOKEN;
const CHAT_KEY = 'akira_chat';
const SESS_PREFIX = 'akira_session:';
const MAX_MESSAGES = 200;

async function rGet(k) {
  if (!RU) return null;
  try {
    const r = await fetch(RU + '/get/' + encodeURIComponent(k), { headers: { Authorization: 'Bearer ' + RT } });
    const d = await r.json();
    if (!d.result) return null;
    let val = JSON.parse(d.result);
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch (e) {} }
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
async function readSession(token) {
  if (!token) return null;
  const s = await rGet(SESS_PREFIX + token);
  if (!s) return null;
  if (s.exp && Date.now() > s.exp) return null;
  return s;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-akira-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!RU) return res.status(500).json({ error: 'Storage not configured.' });

  const body = req.body || {};
  const token = body.token || req.headers['x-akira-token'] || req.query.token;
  const sess = await readSession(token);
  if (!sess) return res.status(401).json({ error: 'Not signed in.' });

  try {
    if (req.method === 'GET') {
      const msgs = (await rGet(CHAT_KEY)) || [];
      const since = Number(req.query.since || 0);
      const out = since ? msgs.filter(m => m.ts > since) : msgs;
      return res.status(200).json({ ok: true, messages: out, serverTime: Date.now() });
    }

    if (req.method === 'POST') {
      const text = String(body.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Empty message.' });
      if (text.length > 2000) return res.status(400).json({ error: 'Message too long.' });
      const msgs = (await rGet(CHAT_KEY)) || [];
      const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), user: sess.username, role: sess.role, text, ts: Date.now() };
      msgs.push(msg);
      while (msgs.length > MAX_MESSAGES) msgs.shift();
      await rSet(CHAT_KEY, msgs);
      return res.status(200).json({ ok: true, message: msg });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
