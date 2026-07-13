// MERCEDES â Inbound SMS Reply Handler (Twilio webhook)
// Twilio "A message comes in" -> POST /api/reply?key=SECRET
// Actions: match lead by phone -> stage 'replied' -> instant TwiML auto-reply with booking link.
export const config = { maxDuration: 30 };

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  if ((req.query.key || '') !== process.env.MERCEDES_SECRET) return res.status(401).send('Unauthorized');

  // Twilio posts x-www-form-urlencoded; Vercel parses it into req.body
  let b = req.body || {};
  if (typeof b === 'string') {
    const p = new URLSearchParams(b); b = {}; for (const [k,v] of p) b[k]=v;
  }
  const from = String(b.From || '');
  const text = String(b.Body || '').trim();
  const digits = s => String(s||'').replace(/\D/g,'').replace(/^1(\d{10})$/, '$1');
  const fromD = digits(from);

  // Opt-out keywords: reply nothing (Twilio enforces STOP automatically)
  const stopWords = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i;
  const isStop = stopWords.test(text);

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  let leadName = '';
  try {
    if (UPSTASH_REDIS_REST_URL && fromD) {
      const r = await fetch(`${UPSTASH_REDIS_REST_URL}/get/akira_pipeline`, { headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` } });
      const d = await r.json();
      let pipeline = d && d.result ? d.result : null;
      for (let i=0;i<3 && typeof pipeline==='string';i++){ try{pipeline=JSON.parse(pipeline);}catch(e){break;} }
      if (!Array.isArray(pipeline)) pipeline = [];
      const idx = pipeline.findIndex(l => l && digits(l.phone) === fromD);
      if (idx >= 0) {
        const lead = pipeline[idx];
        leadName = lead.name || '';
        if (isStop) { lead.stage = 'lost'; lead.optedOut = true; }
        else if (lead.stage !== 'booked' && lead.stage !== 'closed') lead.stage = 'replied';
        lead.lastReply = text.slice(0, 300);
        lead.lastReplyAt = new Date().toISOString();
        if (!Array.isArray(lead.touchpoints)) lead.touchpoints = [];
        lead.touchpoints.push({ type:'sms', outcome: isStop?'opt-out':'replied', note:`ð¥ Inbound SMS: "${text.slice(0,120)}"`, date:new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}), timestamp:Date.now() });
        pipeline[idx] = lead;
        await fetch(`${UPSTASH_REDIS_REST_URL}/set/akira_pipeline`, { method:'POST', headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json' }, body: JSON.stringify(JSON.stringify(pipeline)) });
        // log
        try {
          const lr = await fetch(`${UPSTASH_REDIS_REST_URL}/get/mercedes_log`, { headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` } });
          const ld = await lr.json(); let log = ld && ld.result ? ld.result : [];
          for (let i=0;i<3 && typeof log==='string';i++){ try{log=JSON.parse(log);}catch(e){break;} }
          if (!Array.isArray(log)) log = [];
          log.unshift({ ts:new Date().toISOString(), type: isStop?'OPT-OUT':'REPLIED', name: leadName || from, via:'sms' });
          await fetch(`${UPSTASH_REDIS_REST_URL}/set/mercedes_log`, { method:'POST', headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json' }, body: JSON.stringify(JSON.stringify(log.slice(0,200))) });
        } catch(e){}
      }
    }
  } catch (e) {}

  // Instant TwiML auto-reply (Twilio delivers it â no extra send needed)
  res.setHeader('Content-Type', 'text/xml');
  if (isStop) return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const msg = `Thanks for replying! This is Mercedes with Akira Digital. Robyn would love to connect — grab a free 15-min slot here: cal.com/akira-digital or call/text her directly at (972) 559-0881.`;
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
}

