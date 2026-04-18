// ═══════════════════════════════════════════════════════════════
// MERCEDES — Autonomous AI Revenue Agent v2.0 ($1M Edition)
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
  const hour = now.getUTCHours();
  const shiftStart = parseInt(process.env.SHIFT_START_UTC || '13');
  const shiftEnd   = parseInt(process.env.SHIFT_END_UTC   || '22');
  const dayOfWeek  = now.getUTCDay();

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return res.json({ message: 'Weekend — Mercedes is off.' });
  }
  if (hour < shiftStart || hour >= shiftEnd) {
    return res.json({ message: `Outside shift hours (UTC ${shiftStart}–${shiftEnd}). Current UTC hour: ${hour}` });
  }

  // ── LOAD DATA FROM REDIS ─────────────────────────────────────
  const today = new Date().toDateString();
  function toArray(val) { return Array.isArray(val) ? val : (val && typeof val === 'object' ? Object.values(val) : []); }

  const pipeline    = toArray(await redisGet('akira_pipeline'));
  const workedToday = toArray(await redisGet(`worked_${today}`));
  let   queue       = toArray(await redisGet('mercedes_queue'));
  const logEntries  = toArray(await redisGet('mercedes_log'));

  function log(msg) {
    const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logEntries.unshift({ ts, msg });
  }

  // ── IDENTIFY LEADS TO WORK ───────────────────────────────────
  const active   = pipeline.filter(p => p.stage !== 'lost' && p.stage !== 'closed');

  const unworked = active.filter(p => {
    // Skip if already worked today
    if (workedToday.includes(p.name + (p.address || ''))) return false;

    const pkg = p.mercedesPackage;
    if (!pkg || !pkg.generatedAt) return true; // Never worked — do it

    // Figure out how many days since the last package was generated
    const lastGenDate = new Date(pkg.generatedAt);
    const daysSinceGen = isNaN(lastGenDate)
      ? 99
      : Math.floor((Date.now() - lastGenDate.getTime()) / 86400000);

    const touchCount = (p.touchpoints || []).length;
    const stage = p.stage || 'new';

    // Lead responded or moved to a call/meeting — refresh their package
    if (stage === 'replied' || stage === 'called' || stage === 'meeting') return true;

    // Lead has a package, was contacted, but hasn't responded:
    // Generate follow-ups on Day 3, 7, 14, 30 cadence only
    const followUpDays = [3, 7, 14, 30];
    const alreadyHasFollowUpForDay = followUpDays.find(d => {
      // Check if a touchpoint log entry exists for this follow-up day
      return (p.touchpoints || []).some(t =>
        t.note && t.note.includes(`Day ${d}`) && t.note.includes('follow')
      );
    });

    // Allow work only if we're on a follow-up milestone day and haven't done it yet
    const isFollowUpDay = followUpDays.some(d => {
      const isDue = daysSinceGen >= d;
      const alreadyDone = (p.touchpoints || []).some(t =>
        t.note && t.note.toLowerCase().includes(`day ${d}`)
      );
      return isDue && !alreadyDone;
    });

    if (isFollowUpDay) return true;

    // Has a package and no follow-up is due yet — skip
    log(`⏭ Skipping ${p.name} — package exists (${daysSinceGen}d ago), no follow-up due yet`);
    return false;
  });

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

  const batch = unworked.slice(0, 3);
  log(`🔄 Starting run — ${unworked.length} unworked leads, processing ${batch.length}`);

  const results = { worked: 0, errors: [] };

  // ── PROCESS EACH LEAD ─────────────────────────────────────────
  for (const lead of batch) {
    log(`🔍 Working: ${lead.name} (${lead.stage || 'new'})`);

    try {
      const touchCount = (lead.touchpoints || []).length;
      const touchHistory = (lead.touchpoints || [])
        .map(t => `- ${t.type} on ${t.date}${t.note ? ': ' + t.note : ''}`)
        .join('\n') || 'No previous contact.';

      // ── LEAD SCORING LOGIC ──────────────────────────────────
      const rating = parseFloat(lead.rating) || 0;
      const reviewCount = parseInt(lead.reviewCount) || 0;
      let leadScore = 'warm';
      if (!lead.website && reviewCount >= 10) leadScore = 'hot';
      else if (!lead.website && reviewCount < 10) leadScore = 'warm';
      else if (lead.website && touchCount > 2) leadScore = 'cold';

      // ── UPSELL TIMING ───────────────────────────────────────
      const isClient = lead.stage === 'closed' || lead.stage === 'client';
      const daysSinceLaunch = lead.launchDate
        ? Math.floor((Date.now() - new Date(lead.launchDate)) / 86400000)
        : null;
      let upsellType = null;
      if (isClient && daysSinceLaunch >= 60 && daysSinceLaunch < 90) upsellType = 'growth';
      if (isClient && daysSinceLaunch >= 90) upsellType = 'authority';
      if (isClient && daysSinceLaunch >= 30 && !lead.referralSent) upsellType = 'referral';

      // ── DETERMINE WORK MODE: fresh package or follow-up ─────
      const pkg = lead.mercedesPackage;
      const isFollowUp = !!(pkg && pkg.generatedAt);
      const lastGenDate = isFollowUp ? new Date(pkg.generatedAt) : null;
      const daysSinceGen = lastGenDate && !isNaN(lastGenDate)
        ? Math.floor((Date.now() - lastGenDate.getTime()) / 86400000)
        : 0;
      const followUpStage = isFollowUp
        ? (daysSinceGen >= 30 ? 'day30_breakup'
          : daysSinceGen >= 14 ? 'day14_urgency'
          : daysSinceGen >= 7  ? 'day7_stat'
          : daysSinceGen >= 3  ? 'day3_value'
          : 'refresh')
        : 'initial';

      const previousWorkContext = isFollowUp ? `
PREVIOUS WORK REVIEW:
- Original package generated: ${pkg.generatedAt}
- Days since first contact: ${daysSinceGen}
- Original subject line used: "${pkg.subject || 'unknown'}"
- Original angle used: "${pkg.angle || 'unknown'}"
- Original recommended package: ${pkg.recommendedPackage || 'unknown'}
- Original cold email sent: "${(pkg.coldEmail || '').slice(0, 150)}..."
- Follow-up stage due: ${followUpStage.toUpperCase()}

CRITICAL INSTRUCTION: DO NOT recreate the original package. You are writing the NEXT STEP in the sequence.
${followUpStage === 'day3_value' ? 'Write a Day 3 value-add follow-up. Reference a specific problem for their industry. New angle — do not repeat the cold email.' : ''}
${followUpStage === 'day7_stat' ? 'Write a Day 7 follow-up using a local stat or competitor reference. Show you know their market.' : ''}
${followUpStage === 'day14_urgency' ? 'Write a Day 14 follow-up with a real case study from a similar business. Mention a project slot is available.' : ''}
${followUpStage === 'day30_breakup' ? 'Write a Day 30 breakup email — keep the door open, no hard feelings, 50 words max. They might come back.' : ''}
${followUpStage === 'refresh' ? 'The lead has RESPONDED or stage changed. Refresh the full package with the new context.' : ''}
` : `
PREVIOUS WORK: None — this is the FIRST time contacting this lead. Generate a complete initial outreach package.
`;

      const prompt = `Generate a complete multi-channel outreach package for this lead.

Business: ${lead.name}
Address: ${lead.address || 'Unknown'}
Category: ${lead.category || 'Local business'}
Has website: ${lead.website ? 'Yes — ' + lead.website : 'NO — this is their biggest pain point, lead with this'}
Google Rating: ${rating > 0 ? rating + ' stars' : 'Unknown'}
Review Count: ${reviewCount > 0 ? reviewCount + ' reviews' : 'Unknown'}
Phone: ${lead.phone || 'Unknown'}
Current stage: ${lead.stage || 'New'}
Lead score: ${leadScore.toUpperCase()}
Touch count: ${touchCount}
Upsell opportunity: ${upsellType || 'none'}
Touch history:
${touchHistory}
${previousWorkContext}
PERSONALIZATION RULES:
${rating >= 4.5 ? `- This business has excellent reviews (${rating} stars, ${reviewCount} reviews). Lead with their reputation — "You have ${reviewCount} 5-star reviews but no website to show for it."` : ''}
${rating > 0 && rating < 3.5 ? `- This business has below-average reviews. Do NOT mention their rating. Focus entirely on the opportunity to grow.` : ''}
${!lead.website ? `- NO WEBSITE is the headline. "87% of customers research online before calling. Every day without a site costs you jobs."` : ''}
${touchCount === 0 ? `- This is the FIRST contact. Be bold and specific.` : ''}
${touchCount >= 2 ? `- They have been contacted ${touchCount} times. Create urgency. Mention a project slot.` : ''}
${upsellType === 'referral' ? `- This is a HAPPY CLIENT. Ask for a referral. Offer $100 off their Care Plan.` : ''}
${upsellType === 'growth' ? `- This client launched ${daysSinceLaunch} days ago. Upsell to Growth package — add call tracking and CRM.` : ''}
${upsellType === 'authority' ? `- This client launched ${daysSinceLaunch} days ago. Upsell to Authority — full rebrand and Google Ads.` : ''}

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "subject": "cold email subject line (max 7 words, curiosity-driven, specific to this business)",
  "coldEmail": "Day 1 cold email body (3 short paragraphs, 120 words max, hyper-personalized to their niche and situation, clear CTA)",
  "followUp3": "Day 3 follow-up — value-add angle specific to their category, 80 words",
  "followUp7": "Day 7 follow-up — mention a competitor or relevant stat for their city/niche, 70 words",
  "followUp14": "Day 14 follow-up — case study from similar business type, create urgency with project slot, 70 words",
  "breakup": "Day 30 breakup email — keep door open, no hard feelings, 50 words",
  "linkedin": "LinkedIn connection note (max 280 chars, feels human not salesy, reference something specific about their business)",
  "sms": "Day 7 SMS for warm non-responders (max 160 chars, conversational, one question)",
  "callScript": "30-second cold call opener that earns more time — reference their business specifically",
  "objections": [
    "too expensive rebuttal — use ROI math, 2 sentences",
    "not right now rebuttal — create soft urgency, 2 sentences",
    "we already have someone rebuttal — pivot to quality gap, 2 sentences",
    "I don't need a website rebuttal — use search volume data, 2 sentences"
  ],
  "proposalHook": "one sentence opener for a discovery call that creates instant curiosity specific to their business type",
  "angle": "one-sentence custom hook that would stop THIS specific business owner cold",
  "leadScore": "${leadScore}",
  "priority": "${leadScore === 'hot' ? 'high' : leadScore === 'warm' ? 'medium' : 'low'}",
  "closePct": ${leadScore === 'hot' ? 75 : leadScore === 'warm' ? 40 : 15},
  "recommendedPackage": "${!lead.website ? 'Starter' : 'Growth'}",
  "nextAction": "specific one-sentence instruction for what to do after sending Day 1 email",
  "upsellType": "${upsellType || 'none'}",
  "referralMessage": ${upsellType === 'referral' ? '"pre-written message the client can forward to contacts — 2 sentences max"' : 'null'}
}`;

      const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2500,
          system: `You are Mercedes, the autonomous AI Sales Agent for Akira Digital — a web design agency that builds high-converting websites for home service businesses and law firms in 10 days, starting at $1,000.

YOUR MISSION: Generate outreach packages that close deals. Target: $1M in revenue in 12 months. That means 50 projects/month by Month 12. Every word you write should move a prospect closer to paying.

AKIRA DIGITAL PACKAGES:
- Starter: $1,000 one-time — 3 pages, 10-day delivery, mobile-first, basic SEO, Google Business setup
- Growth: $2,500 one-time — 5 pages, 14-day delivery, GA4, call tracking, CRM integration
- Authority: $5,000+ one-time — 8-10 pages, full rebrand, Google Ads landing pages, local SEO dominance
- Care Plan: $300/month — monthly updates (2hrs), security monitoring, daily backups, SEO report, priority support

YOUR WRITING RULES:
- Never use templates. Every message must feel like it was written specifically for THIS business.
- Lead with their pain, not your features. "You're losing calls" beats "we build websites."
- Use specifics: city names, niche terminology, real numbers.
- One question per message maximum. Never multiple CTAs.
- Under 120 words for cold email. Under 80 words for follow-ups.
- No "I hope this email finds you well." No "synergy." No buzzwords.
- Sound like a person who did 5 minutes of research, not a robot.

NICHE VOICE:
- Plumbers: Emergency calls, licensing, 24/7 availability, insurance work
- HVAC: Seasonal urgency, financing, energy savings, emergency service
- Roofers: Storm damage, insurance claims, free inspections, spring rush
- Law Firms: Trust, case results, free consultation, confidentiality
- General Contractors: Portfolio proof, licensing, timeline guarantees, referrals
- Landscaping: Spring/fall seasons, residential vs commercial, before/after
- Pest Control: Urgency (bugs now!), recurring service, family safety

OBJECTION HANDLING PHILOSOPHY:
Always respond to objections with ROI math or a pivot question. Never get defensive. Always end with a question that moves forward.

You think like a closer. You write like a human. You perform like a machine.`,
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

      // Update pipeline
      const pIdx = pipeline.findIndex(p => p.name === lead.name && p.address === lead.address);
      if (pIdx !== -1) {
        if (!pipeline[pIdx].touchpoints) pipeline[pIdx].touchpoints = [];
        pipeline[pIdx].touchpoints.push({
          type: 'email',
          outcome: 'neutral',
          note: `☁️ Mercedes v2 — ${isFollowUp ? 'Day ' + daysSinceGen + ' follow-up' : 'Initial package'} (${followUpStage}): "${parsed.subject}" | Score: ${parsed.leadScore?.toUpperCase()} | Close: ${parsed.closePct}%`,
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          timestamp: Date.now()
        });
        if (pipeline[pIdx].stage === 'new') pipeline[pIdx].stage = 'contacted';
        pipeline[pIdx].leadScore = parsed.leadScore || leadScore;
        // Preserve original package if this is a follow-up; only overwrite with new content
        const existingPkg = pipeline[pIdx].mercedesPackage || {};
        pipeline[pIdx].mercedesPackage = {
          // Preserve original cold email and subject if this is a follow-up
          subject:           isFollowUp ? (existingPkg.subject || parsed.subject || '') : (parsed.subject || ''),
          coldEmail:         isFollowUp ? (existingPkg.coldEmail || parsed.coldEmail || '') : (parsed.coldEmail || ''),
          // Always update follow-ups with latest versions
          followUp3:         parsed.followUp3 || existingPkg.followUp3 || '',
          followUp7:         parsed.followUp7 || existingPkg.followUp7 || '',
          followUp14:        parsed.followUp14 || existingPkg.followUp14 || '',
          breakup:           parsed.breakup || existingPkg.breakup || '',
          linkedin:          parsed.linkedin || existingPkg.linkedin || '',
          sms:               parsed.sms || existingPkg.sms || '',
          callScript:        parsed.callScript || existingPkg.callScript || '',
          angle:             isFollowUp ? (existingPkg.angle || parsed.angle || '') : (parsed.angle || ''),
          recommendedPackage: parsed.recommendedPackage || existingPkg.recommendedPackage || 'Starter',
          nextAction:        parsed.nextAction || '',
          upsellType:        parsed.upsellType || existingPkg.upsellType || 'none',
          referralMessage:   parsed.referralMessage || existingPkg.referralMessage || null,
          priority:          parsed.priority || existingPkg.priority || 'medium',
          leadScore:         parsed.leadScore || leadScore,
          followUpStage:     followUpStage,
          lastWorked:        new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
          generatedAt:       isFollowUp ? (existingPkg.generatedAt || new Date().toLocaleString()) : new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        };
      }

      // Build queue item
      let objArr = [];
      try {
        objArr = Array.isArray(parsed.objections) ? parsed.objections
          : JSON.parse(parsed.objections || '[]');
      } catch { objArr = [parsed.objections || '']; }

      queue.unshift({
        id: Date.now() + Math.random(),
        source: 'cloud',
        leadName: lead.name,
        leadPhone: lead.phone || '',
        leadAddress: lead.address || '',
        leadCategory: lead.category || '',
        hasWebsite: !!lead.website,
        leadScore: parsed.leadScore || leadScore,
        priority: parsed.priority || 'medium',
        closePct: parsed.closePct || 0,
        recommendedPackage: parsed.recommendedPackage || 'Starter',
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
        nextAction: parsed.nextAction || '',
        upsellType: parsed.upsellType || 'none',
        referralMessage: parsed.referralMessage || null,
        generatedAt: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        date: new Date().toLocaleDateString()
      });

      results.worked++;
      log(`✅ ${lead.name} — ${isFollowUp ? '📨 ' + followUpStage.toUpperCase() : '🆕 INITIAL'} | ${(parsed.leadScore || leadScore).toUpperCase()} | ${parsed.recommendedPackage || 'Starter'} | ${parsed.closePct || '?'}% close | "${parsed.subject}"`);

      // ── SMS VIA TWILIO (Make.com webhook) ─────────────────────
      const SMS_WEBHOOK = process.env.TWILIO_SMS_WEBHOOK;
      const smsText = parsed.sms || '';
      const leadPhone = lead.phone || '';

      // Send SMS on Day 7 warm follow-up OR initial contact for hot leads
      const shouldSendSms = SMS_WEBHOOK && leadPhone && smsText && (
        followUpStage === 'day7_stat' ||
        (!isFollowUp && leadScore === 'hot')
      );

      if (shouldSendSms) {
        try {
          const smsPayload = {
            leadName:     lead.name,
            phone:        leadPhone,
            message:      smsText,
            leadScore:    parsed.leadScore || leadScore,
            followUpStage: followUpStage,
            agentId:      'mercedes'
          };
          const smsResp = await fetch(SMS_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(smsPayload)
          });
          if (smsResp.ok) {
            log(`📱 SMS sent to ${lead.name} (${leadPhone}) — "${smsText.slice(0, 60)}..."`);
            // Record the SMS touchpoint
            if (pIdx !== -1) {
              pipeline[pIdx].touchpoints.push({
                type: 'sms',
                outcome: 'sent',
                note: `📱 Mercedes SMS (${followUpStage}): "${smsText.slice(0, 100)}"`,
                date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                timestamp: Date.now()
              });
              pipeline[pIdx].smsSentAt = new Date().toISOString();
            }
          } else {
            log(`⚠️ SMS webhook responded ${smsResp.status} for ${lead.name} — check Make.com scenario 07`);
          }
        } catch (smsErr) {
          log(`⚠️ SMS trigger failed for ${lead.name}: ${smsErr.message}`);
        }
      } else if (SMS_WEBHOOK && leadPhone && !smsText) {
        log(`⏭ No SMS for ${lead.name} — SMS message not generated`);
      } else if (SMS_WEBHOOK && !leadPhone) {
        log(`⏭ No SMS for ${lead.name} — no phone number on file`);
      }

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
    message: `Mercedes v2 processed ${results.worked} lead${results.worked !== 1 ? 's' : ''}`,
    worked: results.worked,
    remaining: unworked.length - results.worked,
    errors: results.errors
  });
}
