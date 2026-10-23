import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';

function fixture({pacing=true}={}){
 const sqlite=new DatabaseSync(':memory:');
 for(const migration of ['0001_init.sql','0002_action_traces.sql','0003_dynamic_workforce.sql',...(pacing?['0004_provider_pacing.sql']:[])])
  sqlite.exec(fs.readFileSync(new URL('../migrations/'+migration,import.meta.url),'utf8'));
 const DB={prepare(sql){
  const bound=args=>{
   const stmt=sqlite.prepare(sql);
   return {first:async()=>stmt.get(...args)||null,run:async()=>({meta:stmt.run(...args)}),all:async()=>({results:stmt.all(...args)})};
  };
  return {...bound([]),bind:(...args)=>bound(args)};
 }};
 return {env:{DB,IMAGES:{put:async()=>{},get:async()=>null},REVIEW_TOKEN:'review-only',INGEST_TOKEN:'ingest-only',MCP_TOKEN:'mcp-only'},sqlite};
}
async function route(env,url,{method='GET',body=null,token='review-only'}={}){
 const req=new Request('https://worker.example'+url,{method,
  headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{})});
 const response=await worker.fetch(req,env);
 return {status:response.status,body:await response.json()};
}
const post=(env,url,body,token)=>route(env,url,{method:'POST',body,token});
const alice={provider:'pragmatic',runId:'test-catalogue',gameId:'alpha',workerId:'gha-01',leaseSeconds:300};
const policy={provider:'pragmatic',minStartIntervalMs:20000,maxActive:2,enabled:true};

test('global provider pacing requires 0004, is admin-only and schema upgrades to 4',async()=>{
 const f=fixture({pacing:false});
 try{
  const health=await route(f.env,'/health');
  assert.equal(health.body.schemaVersion,3);
  assert.equal(health.body.pacingReady,false);
  const unavailable=await post(f.env,'/v1/work/provider/policy',policy);
  assert.equal(unavailable.status,503);
 }finally{f.sqlite.close();}
 const g=fixture();
 try{
  const health=await route(g.env,'/health');
  assert.equal(health.body.schemaVersion,4);
  assert.equal(health.body.pacingReady,true);
  const unauthorized=await post(g.env,'/v1/work/provider/policy',policy,'ingest-only');
  assert.equal(unauthorized.status,401);
  const ok=await post(g.env,'/v1/work/provider/policy',policy);
  assert.equal(ok.status,200);
  assert.equal(ok.body.policy.minStartIntervalMs,20000);
  const listing=await route(g.env,'/v1/work/provider/policies');
  assert.equal(listing.body.policies[0].enabled,true);
 }finally{g.sqlite.close();}
});

test('provider starts are centrally paced and concurrent sessions capped across workers',async()=>{
 const f=fixture();
 try{
  await post(f.env,'/v1/work/provider/policy',policy);
  const first=await post(f.env,'/v1/work/provider/lease',alice);
  assert.equal(first.status,200);
  assert.equal(first.body.granted,true);
  const second=await post(f.env,'/v1/work/provider/lease',{...alice,gameId:'bravo',workerId:'gha-02'});
  assert.equal(second.body.granted,false);
  assert.equal(second.body.reason,'pacing');
  // Simulate the interval passing while first session remains active.
  f.sqlite.exec("UPDATE provider_policies SET next_start_ms=0 WHERE provider='pragmatic'");
  const allowed=await post(f.env,'/v1/work/provider/lease',{...alice,gameId:'bravo',workerId:'gha-02'});
  assert.equal(allowed.body.granted,true);
  f.sqlite.exec("UPDATE provider_policies SET next_start_ms=0 WHERE provider='pragmatic'");
  const full=await post(f.env,'/v1/work/provider/lease',{...alice,gameId:'charlie',workerId:'gha-03'});
  assert.equal(full.body.granted,false);
  assert.equal(full.body.reason,'capacity');
  const invalidOwner=await post(f.env,'/v1/work/provider/renew',{leaseId:first.body.leaseId,workerId:'stranger',leaseSeconds:300});
  assert.equal(invalidOwner.status,409);
  const renewed=await post(f.env,'/v1/work/provider/renew',{leaseId:first.body.leaseId,workerId:alice.workerId,leaseSeconds:400});
  assert.equal(renewed.body.renewed,true);
  const release=await post(f.env,'/v1/work/provider/release',{leaseId:first.body.leaseId,workerId:alice.workerId});
  assert.equal(release.body.released,true);
  const retry=await post(f.env,'/v1/work/provider/release',{leaseId:first.body.leaseId,workerId:alice.workerId});
  assert.equal(retry.body.unchanged,true);
  const free=await post(f.env,'/v1/work/provider/lease',{...alice,gameId:'delta',workerId:'gha-03'});
  assert.equal(free.body.granted,true);
 }finally{f.sqlite.close();}
});

test('provider policies are independent; expired sessions do not block other games',async()=>{
 const f=fixture();
 try{
  const unknown=await post(f.env,'/v1/work/provider/lease',alice);
  assert.equal(unknown.body.reason,'unconfigured');
  await post(f.env,'/v1/work/provider/policy',policy);
  await post(f.env,'/v1/work/provider/policy',{provider:'playtech',minStartIntervalMs:1000,maxActive:1,enabled:true});
  const a=await post(f.env,'/v1/work/provider/lease',alice);
  const b=await post(f.env,'/v1/work/provider/lease',{...alice,provider:'playtech',gameId:'other',workerId:'gha-02'});
  assert.equal(a.body.granted,true);
  assert.equal(b.body.granted,true);
  // Simulate client crash and the end of the minimum start interval.
  f.sqlite.prepare("UPDATE provider_sessions SET lease_until_ms=? WHERE lease_id=?").run(Date.now()-1000,a.body.leaseId);
  f.sqlite.exec("UPDATE provider_policies SET next_start_ms=0 WHERE provider='pragmatic'");
  const reclaimed=await post(f.env,'/v1/work/provider/lease',{...alice,gameId:'newgame',workerId:'gha-03'});
  assert.equal(reclaimed.body.granted,true);
  assert.equal((await post(f.env,'/v1/work/provider/renew',{leaseId:a.body.leaseId,workerId:alice.workerId})).status,409);
  await post(f.env,'/v1/work/provider/policy',{...policy,enabled:false});
  const disabled=await post(f.env,'/v1/work/provider/lease',{...alice,gameId:'shutdown'});
  assert.equal(disabled.body.reason,'disabled');
 }finally{f.sqlite.close();}
});

test('provider workload exposes run-specific discovery/catalogue progress',async()=>{
 const f=fixture();
 try{
  const jobs=[
   {role:'catalog',provider:'pragmatic',subject:'alpha',payload:{game:{id:'alpha'}}},
   {role:'catalog',provider:'playtech',subject:'beta',payload:{game:{id:'beta'}}},
   {role:'discovery',provider:'pragmatic',subject:'page-42',payload:{source:{id:'page'}}}
  ];
  const saved=await post(f.env,'/v1/work/jobs',{runId:'test-catalogue',jobs});
  assert.equal(saved.body.inserted,3);
  const v=await route(f.env,'/v1/work/providers?runId=test-catalogue');
  assert.equal(v.status,200);
  assert.deepEqual(v.body.providers.map(p=>p.provider),['playtech','pragmatic']);
  assert.equal(v.body.providers[1].discovery.pending,1);
  assert.equal(v.body.providers[1].catalog.pending,1);
  assert.equal((await route(f.env,'/v1/work/providers?runId=another-run')).body.providers.length,0);
 }finally{f.sqlite.close();}
});

test('unstarted tickets can be deferred without burning attempts or stealing a lease',async()=>{
 const f=fixture();
 try{
  const ticket={role:'catalog',provider:'pragmatic',subject:'alpha',payload:{game:{id:'alpha'}}};
  await post(f.env,'/v1/work/jobs',{runId:'test-catalogue',jobs:[ticket]});
  const claimed=(await post(f.env,'/v1/work/claim',{runId:'test-catalogue',role:'catalog',workerId:'gha-runner'})).body.job;
  assert.equal(claimed.attempts,1);
  const denied=await post(f.env,'/v1/work/defer',{id:claimed.id,workerId:'other',leaseToken:claimed.leaseToken,delaySeconds:0});
  assert.equal(denied.status,409);
  const deferred=await post(f.env,'/v1/work/defer',{id:claimed.id,workerId:'gha-runner',leaseToken:claimed.leaseToken,delaySeconds:0});
  assert.equal(deferred.status,200);
  assert.equal(deferred.body.job.status,'pending');
  assert.equal(deferred.body.job.attempts,0);
  const newLease=(await post(f.env,'/v1/work/claim',{runId:'test-catalogue',role:'catalog',workerId:'gha-other'})).body.job;
  assert.equal(newLease.id,claimed.id);
  assert.notEqual(newLease.leaseToken,claimed.leaseToken);
 }finally{f.sqlite.close();}
});
