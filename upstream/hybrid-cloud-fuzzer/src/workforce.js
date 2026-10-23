// Durable D1 work tickets; coordination only. Cloudflare never launches games.
import {InputError} from './candidates.js';

const WORK_ROLES=new Set(['discovery','catalog']);
const AGENT_ROLES=new Set(['discovery','catalog','classification','branches']);
const keyPattern=/^[a-z0-9][a-z0-9_.-]{0,99}$/i;
const subjectPattern=/^[a-z0-9][a-z0-9_.-]{0,149}$/i;
const workerPattern=/^[a-z0-9][a-z0-9_.:-]{0,149}$/i;
const nowSec=()=>Math.floor(Date.now()/1000);
const json=(value,fallback=null)=>{try{return JSON.parse(value);}catch{return fallback;}};
function valid(value,pattern,label){if(typeof value!=='string'||!pattern.test(value))throw new InputError('invalid '+label);return value;}
function positive(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw new InputError('invalid '+label);return value;}
function validRole(value,roles=WORK_ROLES){if(!roles.has(value))throw new InputError('invalid work role');return value;}
function payloadJson(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError('work payload must be an object');
 const out=JSON.stringify(value);
 if(out.length>6000)throw new InputError('work payload too large');
 return out;
}
function publicJob(r){
 if(!r)return null;
 return {id:r.id,runId:r.run_id,role:r.role,provider:r.provider,subject:r.subject,
  payload:json(r.payload_json,{}),priority:r.priority,status:r.status,
  attempts:r.attempts,maxAttempts:r.max_attempts,availableAt:r.available_at,
  leaseToken:r.lease_token||null,leaseOwner:r.lease_owner||null,leaseUntil:r.lease_until||null,
  result:json(r.result_json,null),lastError:r.last_error||null,createdAt:r.created_at};
}
export async function requireWorkforce(env){
 const row=await env.DB.prepare(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('workforce_jobs','workforce_agents')").first();
 if(Number(row?.n)!==2)throw new InputError('workforce D1 migration 0003 missing; run wrangler d1 migrations apply --remote',503);
}
export async function enqueueWork(env,{runId,jobs}={}){
 valid(runId,keyPattern,'runId');
 if(!Array.isArray(jobs)||!jobs.length||jobs.length>20)throw new InputError('work batch must contain 1..20 tickets');
 await requireWorkforce(env);
 const saved=[];let inserted=0;
 for(const job of jobs){
  validRole(job?.role);valid(job?.provider,keyPattern,'provider');valid(job?.subject,subjectPattern,'work subject');
  const priority=positive(job.priority??0,-10,100,'priority');
  const maxAttempts=positive(job.maxAttempts??3,1,8,'maxAttempts');
  const body=payloadJson(job.payload);
  // Stable identity is scoped to one run, provider, role and subject.
  const id=[runId,job.role,job.provider,job.subject].join(':');
  if(id.length>390)throw new InputError('work ticket identity too long');
  const res=await env.DB.prepare(
   "INSERT OR IGNORE INTO workforce_jobs(id,run_id,role,provider,subject,payload_json,priority,max_attempts) VALUES(?,?,?,?,?,?,?,?)")
   .bind(id,runId,job.role,job.provider,job.subject,body,priority,maxAttempts).run();
  const current=await env.DB.prepare('SELECT * FROM workforce_jobs WHERE id=?').bind(id).first();
  if(!current||current.payload_json!==body)throw new InputError('work ticket identity already used for different payload',409);
  if(res.meta?.changes===1)inserted++;
  saved.push(publicJob(current));
 }
 return {inserted,existing:saved.length-inserted,jobs:saved};
}
export async function claimWork(env,{runId,role,provider=null,workerId,leaseSeconds=300}={}){
 valid(runId,keyPattern,'runId');validRole(role);valid(workerId,workerPattern,'workerId');
 if(provider!==null)valid(provider,keyPattern,'provider');
 positive(leaseSeconds,30,900,'leaseSeconds');
 await requireWorkforce(env);
 // Reap exhausted leases after a crashed worker; otherwise a max-attempt
 // ticket could remain in the leased state indefinitely.
 await env.DB.prepare(
  "UPDATE workforce_jobs SET status='failed',lease_token=NULL,lease_owner=NULL,lease_until=NULL,"+
  "last_error='lease expired after maximum attempts',updated_at=datetime('now') "+
  "WHERE run_id=? AND role=? AND status='leased' AND lease_until<=? AND attempts>=max_attempts")
  .bind(runId,role,nowSec()).run();
 // Compare-and-swap: competing hosts can never own the same valid lease.
 const filter=provider?' AND provider=?':'',now=nowSec();
 for(let retry=0;retry<4;retry++){
  const token=crypto.randomUUID();
  const row=await env.DB.prepare(
   "UPDATE workforce_jobs SET status='leased',lease_token=?,lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=datetime('now') "+
   "WHERE id=(SELECT id FROM workforce_jobs WHERE run_id=? AND role=?"+filter+
   " AND available_at<=? AND attempts<max_attempts AND (status='pending' OR (status='leased' AND lease_until<=?)) "+
   "ORDER BY priority DESC,attempts ASC,created_at ASC,id ASC LIMIT 1) "+
   "AND attempts<max_attempts AND (status='pending' OR (status='leased' AND lease_until<=?)) RETURNING *")
   .bind(token,workerId,now+leaseSeconds,runId,role,...(provider?[provider]:[]),now,now,now).first();
  if(row)return publicJob(row);
 }
 return null;
}
export async function renewWork(env,{id,workerId,leaseToken,leaseSeconds=300}={}){
 if(typeof id!=='string'||id.length>390||!id)throw new InputError('invalid job ID');
 valid(workerId,workerPattern,'workerId');
 if(typeof leaseToken!=='string'||leaseToken.length>100)throw new InputError('invalid lease token');
 positive(leaseSeconds,30,900,'leaseSeconds');await requireWorkforce(env);
 const now=nowSec(),row=await env.DB.prepare(
  "UPDATE workforce_jobs SET lease_until=?,updated_at=datetime('now') "+
  "WHERE id=? AND lease_owner=? AND lease_token=? AND status='leased' AND lease_until>? RETURNING *")
  .bind(now+leaseSeconds,id,workerId,leaseToken,now).first();
 if(!row)throw new InputError('stale job lease',409);
 return publicJob(row);
}
export async function finishWork(env,{id,workerId,leaseToken,ok,result=null,error=null}={}){
 if(typeof id!=='string'||id.length>390||!id)throw new InputError('invalid job ID');
 valid(workerId,workerPattern,'workerId');
 if(typeof leaseToken!=='string'||leaseToken.length>100)throw new InputError('invalid lease token');
 if(typeof ok!=='boolean')throw new InputError('completion ok must be boolean');
 const resultJson=result===null?null:JSON.stringify(result);
 if(resultJson&&resultJson.length>6000)throw new InputError('work result exceeds 6000 chars');
 if(!ok&&(typeof error!=='string'||!error||error.length>350))throw new InputError('brief failure reason required');
 await requireWorkforce(env);
 const now=nowSec();
 const row=await env.DB.prepare(
  "UPDATE workforce_jobs SET "+
  "status=CASE WHEN ?=1 THEN 'done' WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,"+
  "available_at=CASE WHEN ?=1 THEN 0 ELSE ?+MIN(600,5*attempts*attempts) END,"+
  "result_json=?,last_error=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=datetime('now') "+
  "WHERE id=? AND lease_owner=? AND lease_token=? AND status='leased' AND lease_until>? RETURNING *")
  .bind(ok?1:0,ok?1:0,now,resultJson,ok?null:error,id,workerId,leaseToken,now).first();
 if(!row)throw new InputError('stale job lease',409);
 return publicJob(row);
}
// Return unstarted work without exhausting retry attempts (e.g. provider pacing
// has no available session, or the GitHub runner is approaching its deadline).
// The exact current D1 lease is required: another worker cannot defer this job.
export async function deferWork(env,{id,workerId,leaseToken,delaySeconds=15}={}){
 if(typeof id!=='string'||!id||id.length>390)throw new InputError('invalid job ID');
 valid(workerId,workerPattern,'workerId');
 if(typeof leaseToken!=='string'||leaseToken.length>100)throw new InputError('invalid lease token');
 positive(delaySeconds,0,900,'delaySeconds');
 await requireWorkforce(env);
 const current=nowSec();
 const row=await env.DB.prepare(
  "UPDATE workforce_jobs SET status='pending',available_at=?,attempts=MAX(0,attempts-1),"+
  "lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=datetime('now') "+
  "WHERE id=? AND status='leased' AND lease_owner=? AND lease_token=? AND lease_until>? RETURNING *")
  .bind(current+delaySeconds,id,workerId,leaseToken,current).first();
 if(!row)throw new InputError('stale job lease',409);
 return publicJob(row);
}

export async function agentHeartbeat(env,{runId,workerId,role,host='local',capacity=1}={}){
 valid(runId,keyPattern,'runId');valid(workerId,workerPattern,'workerId');validRole(role,AGENT_ROLES);
 if(typeof host!=='string'||host.length<1||host.length>90||!/^[a-z0-9_.-]+$/i.test(host))throw new InputError('invalid worker host');
 positive(capacity,1,24,'capacity');
 await requireWorkforce(env);
 const now=nowSec();
 await env.DB.prepare(
  "INSERT INTO workforce_agents(run_id,worker_id,role,host,capacity,last_heartbeat) VALUES(?,?,?,?,?,?) "+
  "ON CONFLICT(run_id,worker_id,role) DO UPDATE SET host=excluded.host,capacity=excluded.capacity,"+
  "last_heartbeat=excluded.last_heartbeat,updated_at=datetime('now')")
  .bind(runId,workerId,role,host,capacity,now).run();
 return {ok:true,workerId,role,heartbeatAt:now};
}
export async function workforceStats(env,{runId}={}){
 valid(runId,keyPattern,'runId');await requireWorkforce(env);
 const rows=await env.DB.prepare(
  "SELECT role,status,COUNT(*) AS n FROM workforce_jobs WHERE run_id=? GROUP BY role,status").bind(runId).all();
 const jobs={discovery:{pending:0,leased:0,done:0,failed:0},catalog:{pending:0,leased:0,done:0,failed:0}};
 for(const r of rows.results||[])if(jobs[r.role]&&r.status in jobs[r.role])jobs[r.role][r.status]=Number(r.n);
 const captures=await env.DB.prepare(
  "SELECT mode,status,COUNT(*) AS n FROM items WHERE run_id=? GROUP BY mode,status").bind(runId).all();
 const captureBacklog={structured:0,hybrid:0,visual:0,leased:0,needsReview:0,classified:0};
 for(const r of captures.results||[]){
  const n=Number(r.n);
  if(r.status==='pending'&&r.mode in captureBacklog)captureBacklog[r.mode]+=n;
  if(r.status==='leased')captureBacklog.leased+=n;
  if(r.status==='needs_review')captureBacklog.needsReview+=n;
  if(r.status==='classified')captureBacklog.classified+=n;
 }
 const candidates=await env.DB.prepare(
  "SELECT COUNT(*) AS n FROM items WHERE run_id=? AND status='classified' "+
  "AND json_valid(decisions_json) AND json_array_length(json_extract(decisions_json,'$.allMarks'))>0")
  .bind(runId).first();
 const agents=await env.DB.prepare(
  "SELECT role,COUNT(*) AS n,SUM(capacity) AS capacity FROM workforce_agents "+
  "WHERE run_id=? AND last_heartbeat>=? GROUP BY role")
  .bind(runId,nowSec()-90).all();
 const active={};
 for(const r of agents.results||[])active[r.role]={workers:Number(r.n),capacity:Number(r.capacity)};
 return {runId,jobs,captures:captureBacklog,actionableClassifications:Number(candidates?.n||0),activeAgents:active};
}
