// api/auth.js — server-side team accounts + sessions for Akira Command Center
// Passwords are hashed (scrypt) and stored in Upstash Redis. Nothing sensitive
// ever lives in the public repo. Reuses the same Upstash env vars as sync.js.
const crypto = require('crypto');

const RU = process.env.UPSTASH_REDIS_REST_URL;
const RT = process.env.UPSTASH_REDIS_REST_TOKEN;
const USERS_KEY = 'akira_team_users';
const SESS_PREFIX = 'akira_session:';
const SESSION_TTL_DAYS = 30;

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
async function rDel(k) {
  if (!RU) return false;
  try { await fetch(RU + '/del/' + encodeURIComponent(k), { method: 'POST', headers: { Authorization: 'Bearer ' + RT } }); return true; }
  catch (e) { return false; }
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 32).toString('hex');
  return { salt: s, hash: h };
}
function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch (e) { return false; }
}
function normUser(u) { return String(u || '').trim().toLowerCase(); }

async function ensureSeed() {
  let users = await rGet(USERS_KEY);
  if (Array.isArray(users) && users.length) return users;
  const ownerUser = normUser(process.env.OWNER_USER || 'robyn');
  const ownerPass = process.env.OWNER_PASSWORD || '';
  if (!ownerPass) return users || [];
  const { salt, hash } = hashPassword(ownerPass);
  users = [{ username: ownerUser, role: 'owner', salt, hash, createdAt: new Date().toISOString() }];
  await rSet(USERS_KEY, users);
  return users;
}
async function getUsers() { return (await rGet(USERS_KEY)) || []; }
async function saveUsers(u) { return rSet(USERS_KEY, u); }

async function newSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + SESSION_TTL_DAYS * 86400000;
  await rSet(SESS_PREFIX + token, { username: user.username, role: user.role, exp });
  return { token, exp };
}
async function readSession(token) {
  if (!token) return null;
  const s = await rGet(SESS_PREFIX + token);
  if (!s) return null;
  if (s.exp && Date.now() > s.exp) { await rDel(SESS_PREFIX + token); return null; }
  return s;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-akira-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!RU) return res.status(500).json({ error: 'Storage not configured (UPSTASH env vars missing in Vercel).' });

  const body = req.body || {};
  const action = body.action || req.query.action;
  const token = body.token || req.headers['x-akira-token'] || req.query.token;

  try {
    if (action === 'login') {
      const users = await ensureSeed();
      const u = normUser(body.username);
      const found = (users || []).find(x => x.username === u);
      if (!found || !verifyPassword(body.password, found.salt, found.hash)) {
        return res.status(401).json({ error: 'Wrong username or password.' });
      }
      const sess = await newSession(found);
      return res.status(200).json({ ok: true, token: sess.token, username: found.username, role: found.role, exp: sess.exp });
    }

    if (action === 'me') {
      const s = await readSession(token);
      if (!s) return res.status(401).json({ error: 'Not signed in.' });
      return res.status(200).json({ ok: true, username: s.username, role: s.role });
    }

    if (action === 'logout') {
      if (token) await rDel(SESS_PREFIX + token);
      return res.status(200).json({ ok: true });
    }

    // Does an owner account exist yet? (drives the first-run setup screen)
    if (action === 'status') {
      const users = await getUsers();
      return res.status(200).json({ ok: true, hasUsers: Array.isArray(users) && users.length > 0, ownerHint: normUser(process.env.OWNER_USER || '') || null });
    }

    // First-run: create the owner account from the login screen (no env password needed).
    if (action === 'setup-owner') {
      const users = await getUsers();
      if (Array.isArray(users) && users.length) return res.status(400).json({ error: 'Setup already done. Please sign in.' });
      const u = normUser(body.username);
      const envOwner = normUser(process.env.OWNER_USER || '');
      if (!u || !body.password) return res.status(400).json({ error: 'Enter a username and password.' });
      if (envOwner && u !== envOwner) return res.status(403).json({ error: 'Owner username must be ' + process.env.OWNER_USER + '.' });
      const { salt, hash } = hashPassword(body.password);
      const owner = { username: u, role: 'owner', salt, hash, createdAt: new Date().toISOString() };
      await saveUsers([owner]);
      const sess = await newSession(owner);
      return res.status(200).json({ ok: true, token: sess.token, username: owner.username, role: owner.role });
    }

    const s = await readSession(token);
    if (!s) return res.status(401).json({ error: 'Not signed in.' });
    if (s.role !== 'owner') return res.status(403).json({ error: 'Owner access required.' });
    const users = await getUsers();

    if (action === 'list-users') {
      return res.status(200).json({ ok: true, users: users.map(x => ({ username: x.username, role: x.role, createdAt: x.createdAt })) });
    }
    if (action === 'add-user') {
      const u = normUser(body.username);
      if (!u || !body.password) return res.status(400).json({ error: 'Username and password required.' });
      if (users.find(x => x.username === u)) return res.status(400).json({ error: 'That username already exists.' });
      const { salt, hash } = hashPassword(body.password);
      const role = body.role === 'owner' ? 'owner' : 'helper';
      users.push({ username: u, role, salt, hash, createdAt: new Date().toISOString() });
      await saveUsers(users);
      return res.status(200).json({ ok: true, username: u, role });
    }
    if (action === 'set-password') {
      const u = normUser(body.username);
      const idx = users.findIndex(x => x.username === u);
      if (idx < 0) return res.status(404).json({ error: 'No such user.' });
      if (!body.password) return res.status(400).json({ error: 'New password required.' });
      const { salt, hash } = hashPassword(body.password);
      users[idx].salt = salt; users[idx].hash = hash;
      await saveUsers(users);
      return res.status(200).json({ ok: true, username: u });
    }
    if (action === 'remove-user') {
      const u = normUser(body.username);
      const target = users.find(x => x.username === u);
      if (!target) return res.status(404).json({ error: 'No such user.' });
      if (target.role === 'owner' && users.filter(x => x.role === 'owner').length <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last owner.' });
      }
      await saveUsers(users.filter(x => x.username !== u));
      return res.status(200).json({ ok: true, removed: u });
    }

    return res.status(400).json({ error: 'Unknown action', action });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
