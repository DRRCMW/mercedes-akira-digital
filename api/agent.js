// ═══════════════════════════════════════════════════════════════
// MERCEDES — Autonomous AI Revenue Agent
// Vercel Serverless Function
// Called by GitHub Actions every 15 min, Mon–Fri, 8am–5pm
// ═══════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // ── CORS ────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mercedes-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── AUTH ────────────────────────────────────────────────────
  const provided = req.headers['x-mercedes-key'] || req.query.key;
  if (provided !== process.env.MERCEDES_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — wrong MERCEDES_SECRET' });
  }

  const { ANTHROPIC_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set in Vercel env vars' });
  if (!UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL not set' });

  // ── UPSTASH REDIS HELPERS ────────────────────────────────────
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
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(value))
    });
    return r.ok;
  }

  // ── SHIFT HOURS CHECK ────────────────────────────────────────
  const now = new Date();
  const hour = now.getUTCHours(); // GitHub Actions runs in UTC
  // Shift: 8am–5pm EST = 13:00–22:00 UTC (adjust if in different timezone)
  // Change these numbers to match YOUR timezone offset
  const shiftStart = parseInt(process.env.SHIFT_START_UTC || '13'); // 8am EST
  const shiftEnd   = parseInt(process.env.SHIFT_END_UTC   || '22'); // 5pm EST
  const dayOfWeek  = now.getUTCDay(); // 0=Sun, 6=Sat

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return res.json({ message: 'Weekend — Mercedes is off.' });
  }
  if (hour < shiftStart || hour >= shiftEnd) {
    return res.json({ message: `Outside shift hours (UTC ${shiftStart}–${shiftEnd}). Current UTC hour: ${hour}` });
  }

  // ── LOAD DATA FROM REDIS ─────────────────────────────────────
  const today = new Date().toDateString();
  const pipeline    = (await redisGet('akira_pipeline'))       || [];
  const workedToday = (await redisGet(`worked_${today}`))      || [];
  let   queue       = (await redisGet('mercedes_queue'))       || [];
  const logEntries  = (await redisGet('mercedes_log'))         || [];

  function log(msg) {
    const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logEntries.unshift({ ts, msg });
  }

  // ── IDENTIFY LEADS TO WORK ───────────────────────────────────
  const active   = pipeline.filter(p => p.stage !== 'lost' && p.stage !== 'closed');
  const unworked = active.filter(p => !workedToday.includes(p.name + (p.address || '')));

  if (unworked.length === 0) {
    log('✅ All active leads worked today.');
    await redisSet('mercedes_log', logEntries.slice(0, 200));
    return res.json({ message: 'All leads worked today — Mercedes crushed it!', worked: 0, remaining: 0 });
  }

  // Sort: no website > fewer touches > higher score
  unworked.sort((a, b) => {
    const aHot = !a.website ? 10 : 0;
    const bHot = !b.website ? 10 : 0;
    const aTouches = (a.touchpoints || []).length;
    const bTouches = (b.touchpoints || []).length;
    return (bHot - aHot) || (aTouches - bTouches) || ((b.score || 0) - (a.score || 0));
  });

  // Process up to 3 leads per run (keeps within 60s Vercel timeout)
  const batch = unworked.slice(0, 3);
  log(`🔄 Starting run — ${unworked.length} unworked leads, processing ${batch.length}`);

  const results = { worked: 0, errors: [] };

  // ── PROCESS EACH LEAD ─────────────────────────────────────────
  for (const lead of batch) {
    log(`🔍 Working: ${lead.name} (${lead.stage || 'new'})`);

    try {
      const touchHistory = (lead.touchpoints || [])
        .map(t => `- ${t.type} on ${t.date}${t.note ? ': ' + t.note : ''}`)
        .join('\n') || 'No previous contact.';

      const prompt = `Generate a complete multi-channel outreach package for this lead.

Business: ${lead.name}
Address: ${lead.address || 'Unknown'}
Category: ${lead.category || 'Local business'}
Has website: ${lead.website ? 'Yes — ' + lead.website : 'NO — biggest pain point, lead with this'}
Rating: ${lead.rating || 'Unknown'}
Phone: ${lead.phone || 'Unknown'}
Current stage: ${lead.stage || 'New'}
Touch count: ${(lead.touchpoints || []).length}
Touch history:
${touchHistory}

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "subject": "cold email subject line (max 7 words, curiosity-driven)",
  "coldEmail": "Day 1 cold email body (3 short paragraphs, 120 words max, clear CTA)",
  "followUp3": "Day 3 follow-up — value-add angle, 80 words",
  "followUp7": "Day 7 follow-up — industry trend or competitor mention, 70 words",
  "followUp14": "Day 14 follow-up — case study or social proof, 70 words",
  "breakup": "Day 30 breakup email — keep door open, 50 words",
  "linkedin": "LinkedIn connection note (max 280 chars, personal not salesy)",
  "sms": "Day 7 SMS for warm non-responders (max 160 chars)",
  "callScript": "30-second cold call opener to earn more time on the phone",
  "objections": ["too expensive rebuttal (2 sentences)", "not right now rebuttal (2 sentences)", "we already have someone rebuttal (2 sentences)"],
  "proposalHook": "one sentence opener for a discovery call that creates instant curiosity",
  "angle": "one-sentence custom hook for this specific business",
  "priority": "high",
  "closePct": 75
}`;

      const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          system: 'You are Mercedes, a senior AI sales account executive for a web design agency. You build high-converting websites for local businesses. Sharp, strategic, personalized. Your writing is confident and warm — never a template. You think like a closer. Always deeply personalize to the specific business type and situation.',
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!anthropicResp.ok) {
        const err = await anthropicResp.text();
        throw new Error(`Anthropic API error: ${err}`);
      }

      const anthropicData = await anthropicResp.json();
      const raw = (anthropicData.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw);

      // Mark lead as worked
      workedToday.push(lead.name + (lead.address || ''));

      // Update pipeline touchpoints
      const pIdx = pipeline.findIndex(p => p.name === lead.name && p.address === lead.address);
      if (pIdx !== -1) {
        if (!pipeline[pIdx].touchpoints) pipeline[pIdx].touchpoints = [];
        pipeline[pIdx].touchpoints.push({
          type: 'email',
          outcome: 'neutral',
          note: `☁️ Mercedes (cloud agent) generated package: "${parsed.subject}"`,
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          timestamp: Date.now()
        });
        if (pipeline[pIdx].stage === 'new') pipeline[pIdx].stage = 'contacted';
      }

      // Build queue item
      let objArr = [];
      try {
        objArr = Array.isArray(parsed.objections) ? parsed.objections
          : JSON.parse(parsed.objections || '[]');
      } catch { objArr = [parsed.objections || '']; }

      queue.unshift({
        id: Date.now() + Math.random(),
        source: 'cloud', // ☁️ flag — generated autonomously
        leadName: lead.name,
        leadPhone: lead.phone || '',
        leadAddress: lead.address || '',
        leadCategory: lead.category || '',
        hasWebsite: !!lead.website,
        priority: parsed.priority || 'medium',
        closePct: parsed.closePct || 0,
        subject: parsed.subject || '',
        coldEmail: parsed.coldEmail || '',
        followUp3: parsed.followUp3 || '',
        followUp7: parsed.followUp7 || '',
        followUp14: parsed.followUp14 || '',
        breakup: parsed.breakup || '',
        linkedin: parsed.linkedin || '',
        sms: parsed.sms || '',
        callScript: parsed.callScript || '',
        objections: objArr,
        proposalHook: parsed.proposalHook || '',
        angle: parsed.angle || '',
        generatedAt: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        date: new Date().toLocaleDateString()
      });

      results.worked++;
      log(`✅ ${lead.name} — package ready. Priority: ${(parsed.priority || 'medium').toUpperCase()} · ${parsed.closePct || '?'}% close`);

    } catch (err) {
      results.errors.push(`${lead.name}: ${err.message}`);
      log(`❌ Error on ${lead.name}: ${err.message}`);
    }
  }

  // ── SAVE EVERYTHING BACK TO REDIS ───────────────────────────
  await Promise.all([
    redisSet('akira_pipeline', pipeline),
    redisSet(`worked_${today}`, workedToday),
    redisSet('mercedes_queue', queue.slice(0, 100)),
    redisSet('mercedes_log', logEntries.slice(0, 200)),
    redisSet('mercedes_last_run', { ts: new Date().toISOString(), ...results })
  ]);

  return res.json({
    message: `Mercedes processed ${results.worked} lead${results.worked !== 1 ? 's' : ''}`,
    worked: results.worked,
    remaining: unworked.length - results.worked,
    errors: results.errors
  });
}
