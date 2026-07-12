// MERCEDES â Booking Handler: marks a lead "booked" when Cal.com fires a booking.
// POST /api/book  (auth: x-mercedes-key header OR ?key= OR body.key === MERCEDES_SECRET)
// Body may be a raw Cal.com webhook payload OR {phone, name, email, leadId}.
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mercedes-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const provided = req.headers['x-mercedes-key'] || req.query.key || body.key;
  if (provided !== process.env.MERCEDES_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Redis not configured' });

  // ---- extract identifying info from either a flat body or a Cal.com payload ----
  const p = body.payload || body;
  const attendee = (p.attendees && p.attendees[0]) || {};
  const responses = p.responses || {};
  const digits = s => (s == null ? '' : String(s).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1'));

  const leadId = body.leadId || (p.metadata && p.metadata.leadId) || (responses.leadId && responses.leadId.value) || null;
  const phoneRaw = body.phone || attendee.phoneNumber || (responses.phone && responses.phone.value) ||
                   (responses.attendeePhoneNumber && responses.attendeePhoneNumber.value) || (p.location) || '';
  const phone = digits(phoneRaw);
  const name = (body.name || attendee.name || (responses.name && responses.name.value) || '').toLowerCase().trim();
  const email = (body.email || attendee.email || (responses.email && responses.email.value) || '').toLowerCase().trim();

  async function redisGet(k) {
    const r = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${k}`, { headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` } });
    const d = await r.json();
    let v = d && d.result ? d.result : null;
    for (let i = 0; i < 3 && typeof v === 'string'; i++) { try { v = JSON.parse(v); } catch (e) { break; } }
    return v;
  }
  async function redisSet(k, val) {
    // match the agent's storage format exactly (double-encoded)
    return fetch(`${UPSTASH_REDIS_REST_URL}/set/${k}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(val))
    }).then(r => r.ok);
  }

  let pipeline = await redisGet('akira_pipeline');
  if (!Array.isArray(pipeline)) pipeline = pipeline && typeof pipeline === 'object' ? Object.values(pipeline) : [];

  // ---- match a lead ----
  let idx = -1;
  if (leadId) { const L = String(leadId); idx = pipeline.findIndex(l => l && (String(l.uid) === L || String(l.place_id) === L)); }
  if (idx < 0 && phone) idx = pipeline.findIndex(l => l && digits(l.phone) && digits(l.phone) === phone);
  if (idx < 0 && name) idx = pipeline.findIndex(l => l && String(l.name || '').toLowerCase().trim() === name);

  if (idx < 0) {
    return res.status(200).json({ matched: false, note: 'No lead matched', tried: { leadId, phone, name, email } });
  }

  const lead = pipeline[idx];
  const setStage = body.setStage || (p.setStage) || 'booked';
  lead.stage = setStage;
  lead.booked = (setStage === 'booked');
  lead.bookedAt = new Date().toISOString();
  lead.bookingStart = p.startTime || body.startTime || null;
  lead.touchpoints = (parseInt(lead.touchpoints, 10) || 0) + 1;
  lead.nextFollowup = null;
  pipeline[idx] = lead;

  await redisSet('akira_pipeline', pipeline);

  // append to log (best-effort)
  try {
    let log = await redisGet('mercedes_log');
    if (!Array.isArray(log)) log = [];
    log.unshift({ ts: new Date().toISOString(), type: 'BOOKED', name: lead.name, via: 'cal.com' });
    await redisSet('mercedes_log', log.slice(0, 200));
  } catch (e) {}

  // Instant SMS confirmation to the lead (via Make/Twilio webhook)
  try {
    const SMS_WEBHOOK = process.env.TWILIO_SMS_WEBHOOK;
    if (SMS_WEBHOOK && lead.phone && setStage === 'booked') {
      const when = lead.bookingStart ? new Date(lead.bookingStart).toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZone:'America/Los_Angeles' }) + ' PT' : 'your selected time';
      await fetch(SMS_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadName: lead.name, phone: lead.phone,
          message: `You're booked! ${when} with Robyn at Akira Digital (15 min). You'll get a calendar invite by email. Need to reschedule? cal.com/akira-digital`,
          leadScore: 'hot', followUpStage: 'booking_confirm', agentId: 'mercedes'
        })
      });
    }
  } catch (e) {}

  return res.status(200).json({ matched: true, name: lead.name, stage: lead.stage, bookedAt: lead.bookedAt });
}

