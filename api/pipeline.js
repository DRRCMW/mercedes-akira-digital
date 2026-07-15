// api/pipeline.js — session-authenticated pipeline access for logged-in team.
// Uses the same Upstash Redis + akira session tokens as auth.js/chat.js.
// GET  ?token=..            -> { pipeline: [...] }
// POST { token, lead }      -> appends one candidate to the shared pipeline
const RU = process.env.UPSTASH_REDIS_REST_URL;
const RT = process.env.UPSTASH_REDIS_REST_TOKEN;
const PIPE_KEY = 'akira_pipeline';
const SESS_PREFIX = 'akira_session:';

async function rGet(k){
  if(!RU) return null;
  try{
    const r=await fetch(RU+'/get/'+encodeURIComponent(k),{headers:{Authorization:'Bearer '+RT}});
    const d=await r.json(); if(!d.result) return null;
    let v=JSON.parse(d.result); if(typeof v==='string'){try{v=JSON.parse(v);}catch(e){}} return v;
  }catch(e){ return null; }
}
async function rSet(k,v){
  if(!RU) return false;
  try{ await fetch(RU+'/set/'+encodeURIComponent(k),{method:'POST',headers:{Authorization:'Bearer '+RT,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(v))}); return true; }
  catch(e){ return false; }
}
async function readSession(token){
  if(!token) return null;
  const s=await rGet(SESS_PREFIX+token);
  if(!s) return null;
  if(s.exp && Date.now()>s.exp) return null;
  return s;
}

module.exports = async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-akira-token');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(!RU) return res.status(500).json({error:'Storage not configured.'});

  const body=req.body||{};
  const token=body.token||req.headers['x-akira-token']||req.query.token;
  const sess=await readSession(token);
  if(!sess) return res.status(401).json({error:'Not signed in.'});

  try{
    if(req.method==='GET'){
      const pipeline=await rGet(PIPE_KEY)||[];
      return res.status(200).json({ok:true,pipeline:pipeline});
    }
    if(req.method==='POST'){
      const lead=body.lead;
      if(!lead||!lead.name) return res.status(400).json({error:'lead.name required'});
      const pipeline=await rGet(PIPE_KEY)||[];
      lead.uid=lead.uid||Date.now();
      lead.place_id=lead.place_id||('manual-'+lead.uid);
      lead.stage=lead.stage||'new';
      lead.addedAt=lead.addedAt||new Date().toISOString();
      lead.touchpoints=lead.touchpoints||[];
      lead.addedBy=sess.username;
      if(!pipeline.some(function(x){return x.place_id===lead.place_id;})) pipeline.push(lead);
      await rSet(PIPE_KEY,pipeline);
      await rSet('akira_last_run',new Date().toISOString());
      return res.status(200).json({ok:true,total:pipeline.length,added:lead.name});
    }
    return res.status(405).json({error:'GET or POST only'});
  }catch(e){ return res.status(500).json({error:String(e&&e.message||e)}); }
};
