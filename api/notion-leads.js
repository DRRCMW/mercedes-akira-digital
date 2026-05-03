export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-mercedes-key, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = req.headers['x-mercedes-key'] || req.query.key;
  if (key !== 'Mercedes2707') return res.status(401).json({ error: 'Unauthorized' });

  const NT = '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';
  const DB = 'a3d2c021b2cc4aed983b10886908824a';

  try {
    const all = [];
    let cursor = null;
    let page = 0;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const nr = await fetch('https://api.notion.com/v1/databases/' + DB + '/query', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + NT,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const nd = await nr.json();
      if (!nr.ok) return res.status(500).json({ error: 'Notion API error', detail: nd });
      all.push(...(nd.results || []));
      cursor = nd.has_more ? nd.next_cursor : null;
      page++;
    } while (cursor && page < 20);

    const leads = all.map((rec, i) => {
      const p = rec.properties || {};
      const name = (p['Business Name']?.title || [])[0]?.plain_text || 'Unknown';
      const phone = p['Phone']?.phone_number || '';
      const city = (p['City']?.rich_text || [])[0]?.plain_text || 'Los Angeles';
      const state = (p['State']?.rich_text || [])[0]?.plain_text || 'CA';
      const rating = p['Google Rating']?.number || 4.5;
      const reviews = p['Review Count']?.number || 0;
      const tier = p['Lead Score']?.select?.name || 'Hot';
      const outreach = p['Outreach Status']?.select?.name || 'Not Started';
      const website = p['Website Status']?.select?.name || 'No Website';
      const addedAt = rec.created_time || '';
      let stage = 'new';
      if (['Day 1 Sent','Day 3 Sent','Day 7 Sent','Day 14 Sent','Day 21 Sent'].includes(outreach)) stage = 'contacted';
      else if (outreach === 'Responded' || outreach === 'Meeting Booked') stage = 'meeting';
      else if (outreach === 'Closed Won') stage = 'won';
      else if (outreach === 'Closed Lost') stage = 'lost';
      return {
        place_id: 'notion-' + rec.id.replace(/-/g, ''),
        notion_id: rec.id,
        name, phone,
        address: city + ', ' + state + ', USA',
        city, state, rating, reviews,
        score: Math.min(100, Math.round(rating * 10 + (reviews > 20 ? 10 : 0))),
        tier, reason: website,
        angle: 'Notion Prospect Finder', stage,
        touchpoints: [], nextFollowup: null, addedAt,
        uid: new Date(addedAt).getTime() + i
      };
    });

    return res.status(200).json({ total: leads.length, pages: page, leads });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
    }export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-mercedes-key, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const key = req.headers['x-mercedes-key'] || req.query.key;
  if (key !== 'Mercedes2707') return res.status(401).json({ error: 'Unauthorized' });
  const NT = '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';
  const DB = 'a3d2c021b2cc4aed983b10886908824a';
  try {
    const all = [];
    let cursor = null;
    let page = 0;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const nr = await fetch('https://api.notion.com/v1/databases/' + DB + '/query', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + NT, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const nd = await nr.json();
      if (!nr.ok) return res.status(500).json({ error: 'Notion error', detail: nd });
      all.push(...(nd.results || []));
      cursor = nd.has_more ? nd.next_cursor : null;
      page++;
    } while (cursor && page < 20);
    const leads = all.map((rec, i) => {
      const p = rec.properties || {};
      const name = (p['Business Name']?.title || [])[0]?.plain_text || 'Unknown';
      const phone = p['Phone']?.phone_number || '';
      const city = (p['City']?.rich_text || [])[0]?.plain_text || 'Los Angeles';
      const state = (p['State']?.rich_text || [])[0]?.plain_text || 'CA';
      const rating = p['Google Rating']?.number || 4.5;
      const reviews = p['Review Count']?.number || 0;
      const tier = p['Lead Score']?.select?.name || 'Hot';
      const outreach = p['Outreach Status']?.select?.name || 'Not Started';
      const website = p['Website Status']?.select?.name || 'No Website';
      const addedAt = rec.created_time || '';
      let stage = 'new';
      if (['Day 1 Sent','Day 3 Sent','Day 7 Sent','Day 14 Sent','Day 21 Sent'].includes(outreach)) stage = 'contacted';
      else if (outreach === 'Responded' || outreach === 'Meeting Booked') stage = 'meeting';
      else if (outreach === 'Closed Won') stage = 'won';
      else if (outreach === 'Closed Lost') stage = 'lost';
      return { place_id: 'notion-' + rec.id.replace(/-/g, ''), notion_id: rec.id, name, phone, address: city + ', ' + state + ', USA', city, state, rating, reviews, score: Math.min(100, Math.round(rating * 10 + (reviews > 20 ? 10 : 0))), tier, reason: website, angle: 'Notion Prospect Finder', stage, touchpoints: [], nextFollowup: null, addedAt, uid: new Date(addedAt).getTime() + i };
    });
    return res.status(200).json({ total: leads.length, pages: page, leads });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
    }
