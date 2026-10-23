// Cross-runner, cross-run provider throttling and concurrent-session leases.
// Every provider must be explicitly configured. D1 CAS serializes starts;
// expired leases are excluded from the active-session count automatically.
import {InputError} from './candidates.js';
const slug=/^[a-z0-9][a-z0-9_.-]{0,99}$/i;
const worker=/^[a-z0-9][a-z0-9_.:-]{0,149}$/i;
const now=()=>Date.now();
const integer=(v,min,max,name)=>{
 if(!Number.isSafeInteger(v)||v<min||v>max)throw new InputError('invalid '+name);
 return v;
};
const identity=(v,re,name)=>{
 if(typeof v!=='string'||!re.test(v))throw new InputError('invalid '+name);
 return v;
};
async function ensureTable(env){
 const row=await env.DB.prepare(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('provider_policies','provider_sessions')").first();
 if(Number(row?.n)!==2)throw new InputError('provider pacing D1 migration 0004 missing',503);
}
function policyRow(r){
 return {provider:r.provider,enabled:r.enabled===1,
  minStartIntervalMs:r.min_start_interval_ms,maxActive:r.max_active,
  nextStartMs:r.next_start_ms};
}
export async function setProviderPolicy(env,{provider,minStartIntervalMs,maxActive,enabled=false}={}){
 identity(provider,slug,'provider');
 integer(minStartIntervalMs,1000,300000,'minStartIntervalMs');
 integer(maxActive,1,32,'maxActive');
 if(typeof enabled!=='boolean')throw new InputError('enabled must be boolean');
 await ensureTable(env);
 // Preserve next_start_ms across changes to avoid erasing an existing throttle.
 await env.DB.prepare(
  "INSERT INTO provider_policies(provider,min_start_interval_ms,max_active,enabled) VALUES(?,?,?,?) "+
  "ON CONFLICT(provider) DO UPDATE SET min_start_interval_ms=excluded.min_start_interval_ms,"+
  "max_active=excluded.max_active,enabled=excluded.enabled,updated_at=datetime('now')")
  .bind(provider,minStartIntervalMs,maxActive,enabled?1:0).run();
 const row=await env.DB.prepare('SELECT * FROM provider_policies WHERE provider=?').bind(provider).first();
 return policyRow(row);
}
export async function providerPolicies(env){
 await ensureTable(env);
 const result=await env.DB.prepare('SELECT * FROM provider_policies ORDER BY provider').all();
 const policies=(result.results||[]).map(policyRow);
 return {policies};
}
export async function acquireProviderSession(env,{
 provider,runId,gameId,workerId,leaseSeconds=600
}={}){
 identity(provider,slug,'provider');
 identity(runId,slug,'runId');
 identity(gameId,slug,'gameId');
 identity(workerId,worker,'workerId');
 integer(leaseSeconds,30,900,'leaseSeconds');
 await ensureTable(env);
 const at=now();
 // Gate both the START RATE and active concurrency using one D1 CAS update.
 // A concurrently arriving request cannot reserve the same start interval.
 // The session INSERT follows immediately; on an INSERT failure the reserved
 // start interval stays consumed (safe under-throttling, never over-throttling).
 const row=await env.DB.prepare(
  "UPDATE provider_policies SET next_start_ms=?+min_start_interval_ms "+
  "WHERE provider=? AND enabled=1 AND next_start_ms<=? "+
  "AND (SELECT COUNT(*) FROM provider_sessions WHERE provider=? "+
  "AND released_at_ms IS NULL AND lease_until_ms>?)<max_active RETURNING *")
  .bind(at,provider,at,provider,at).first();
 if(!row){
  const policy=await env.DB.prepare('SELECT * FROM provider_policies WHERE provider=?').bind(provider).first();
  if(!policy||policy.enabled!==1)return {
   granted:false,provider,reason:policy?'disabled':'unconfigured',retryAfterMs:30000};
  const active=await env.DB.prepare(
   "SELECT COUNT(*) AS n,MIN(lease_until_ms) AS first_expiry FROM provider_sessions "+
   "WHERE provider=? AND released_at_ms IS NULL AND lease_until_ms>?")
   .bind(provider,at).first();
  const delayed=Math.max(0,policy.next_start_ms-at);
  const busy=Number(active?.n||0)>=policy.max_active;
  const retry=Math.max(1000,Math.min(60000,Math.max(delayed,
   busy?Math.max(1000,Number(active.first_expiry||at+1000)-at):0)));
  return {granted:false,provider,reason:busy?'capacity':'pacing',
   retryAfterMs:retry,maxActive:policy.max_active,active:Number(active?.n||0)};
 }
 const leaseId=crypto.randomUUID();
 const until=at+leaseSeconds*1000;
 await env.DB.prepare(
  "INSERT INTO provider_sessions(lease_id,provider,run_id,game_id,owner,lease_until_ms,created_at_ms) "+
  "VALUES(?,?,?,?,?,?,?)")
  .bind(leaseId,provider,runId,gameId,workerId,until,at).run();
 return {granted:true,leaseId,provider,runId,gameId,leaseUntilMs:until,
  minStartIntervalMs:row.min_start_interval_ms,maxActive:row.max_active};
}
export async function renewProviderSession(env,{leaseId,workerId,leaseSeconds=600}={}){
 if(typeof leaseId!=='string'||!/[a-f0-9-]{36}/i.test(leaseId)||leaseId.length!==36)throw new InputError('invalid leaseId');
 identity(workerId,worker,'workerId');
 integer(leaseSeconds,30,900,'leaseSeconds');
 await ensureTable(env);
 const at=now(),until=at+leaseSeconds*1000;
 const row=await env.DB.prepare(
  "UPDATE provider_sessions SET lease_until_ms=? WHERE lease_id=? AND owner=? "+
  "AND released_at_ms IS NULL AND lease_until_ms>? RETURNING *")
  .bind(until,leaseId,workerId,at).first();
 if(!row)throw new InputError('stale or expired provider session',409);
 return {renewed:true,leaseId,leaseUntilMs:row.lease_until_ms};
}
export async function releaseProviderSession(env,{leaseId,workerId}={}){
 if(typeof leaseId!=='string'||!/[a-f0-9-]{36}/i.test(leaseId)||leaseId.length!==36)throw new InputError('invalid leaseId');
 identity(workerId,worker,'workerId');
 await ensureTable(env);
 const at=now();
 const row=await env.DB.prepare(
  "UPDATE provider_sessions SET released_at_ms=? "+
  "WHERE lease_id=? AND owner=? AND released_at_ms IS NULL RETURNING *")
  .bind(at,leaseId,workerId).first();
 if(row)return {released:true,leaseId};
 // Idempotence only for the original lease owner.
 const existing=await env.DB.prepare('SELECT owner,released_at_ms FROM provider_sessions WHERE lease_id=?').bind(leaseId).first();
 if(existing?.owner===workerId&&existing.released_at_ms!==null)return {released:true,leaseId,unchanged:true};
 throw new InputError('provider lease not owned',409);
}
export async function providerWorkload(env,{runId}={}){
 identity(runId,slug,'runId');await ensureTable(env);
 const result=await env.DB.prepare(
  "SELECT provider,role,status,COUNT(*) AS n FROM workforce_jobs WHERE run_id=? "+
  "GROUP BY provider,role,status ORDER BY provider,role,status").bind(runId).all();
 const map=new Map();
 for(const row of result.results||[]){
  if(!map.has(row.provider))map.set(row.provider,{provider:row.provider,
   discovery:{pending:0,leased:0,done:0,failed:0},
   catalog:{pending:0,leased:0,done:0,failed:0}});
  const entry=map.get(row.provider);
  if(entry[row.role]&&row.status in entry[row.role])entry[row.role][row.status]=Number(row.n);
 }
 return {runId,providers:[...map.values()]};
}
