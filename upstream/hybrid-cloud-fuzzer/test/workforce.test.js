import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
import {planWorkforce} from '../local/work-allocation.js';
import {classifyStructured} from '../local/structured-classifier.js';
import {selectPublicDemoLinks,validateDiscoverySource,discoveryTicketSubject,validateDiscoveryTicket} from '../local/discover.js';

const runId='work-test';
function fixture({migrate=true}={}){
 const sqlite=new DatabaseSync(':memory:');
 for(const name of ['0001_init.sql','0002_action_traces.sql',...(migrate?['0003_dynamic_workforce.sql']:[])])
  sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const DB={prepare(sql){
  const stmt=sqlite.prepare(sql);
  const bound=args=>({query:sql,args,first:async()=>stmt.get(...args)||null,run:async()=>({meta:stmt.run(...args)}),all:async()=>({results:stmt.all(...args)})});
  return {...bound([]),bind:(...args)=>bound(args)};
 },async batch(stmts){sqlite.exec('BEGIN');try{
  const result=stmts.map(s=>({meta:sqlite.prepare(s.query).run(...s.args)}));
  sqlite.exec('COMMIT');return result;
 }catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,IMAGES:{put:async()=>{},get:async()=>null},REVIEW_TOKEN:'review-test',INGEST_TOKEN:'ingest-test',MCP_TOKEN:'mcp-test'};
 return {env,sqlite,close:()=>sqlite.close()};
}
async function request(env,route,{method='GET',body=null,token='review-test'}={}){
 return worker.fetch(new Request('https://worker.example'+route,{method,headers:{
  Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{})}),env);
}
const ticket=(provider,subject,role='catalog')=>({
 provider,subject,role,priority:5,
 payload:role==='catalog'?{game:{id:subject,provider,url:'https://demo.example.org/games/'+subject+'/'}}:{source:{id:subject,provider}}
});
const post=(env,route,body)=>request(env,route,{method:'POST',body});
test('missing D1 migration does not break legacy health, but refuses unsafe work dispatch',async()=>{
 const f=fixture({migrate:false});try{
  const health=(await (await request(f.env,'/health',{token:'none'})).json());
  assert.equal(health.schemaVersion,2);assert.equal(health.workforceReady,false);
  const res=await post(f.env,'/v1/work/jobs',{runId,jobs:[ticket('pragmatic','alpha')]});
  assert.equal(res.status,503);
  assert.match((await res.json()).error,/migration 0003/);
 }finally{f.close();}
});
test('workforce jobs are idempotent, claim atomically, renew, complete, and reject stale lease tokens',async()=>{
 const f=fixture();try{
  assert.equal((await request(f.env,'/v1/work/stats?runId='+runId,{token:'ingest-test'})).status,401);
  const jobs=[ticket('pragmatic','alpha'),ticket('playtech','beta'),ticket('pragmatic','seed','discovery')];
  let res=await post(f.env,'/v1/work/jobs',{runId,jobs});
  assert.equal(res.status,201);assert.equal((await res.json()).inserted,3);
  res=await post(f.env,'/v1/work/jobs',{runId,jobs});
  assert.equal((await res.json()).existing,3);
  const changed={...jobs[0],payload:{different:true}};
  assert.equal((await post(f.env,'/v1/work/jobs',{runId,jobs:[changed]})).status,409);
  const a=(await (await post(f.env,'/v1/work/claim',{runId,role:'catalog',workerId:'host-1',leaseSeconds:300})).json()).job;
  const b=(await (await post(f.env,'/v1/work/claim',{runId,role:'catalog',workerId:'host-2',leaseSeconds:300})).json()).job;
  assert.ok(a);assert.ok(b);assert.notEqual(a.id,b.id);
  assert.equal((await (await post(f.env,'/v1/work/claim',{runId,role:'catalog',workerId:'host-3'})).json()).job,null);
  assert.equal((await post(f.env,'/v1/work/finish',{id:a.id,workerId:'host-2',leaseToken:a.leaseToken,ok:true})).status,409);
  const renewed=(await (await post(f.env,'/v1/work/renew',{id:a.id,workerId:'host-1',leaseToken:a.leaseToken,leaseSeconds:400})).json()).job;
  assert.ok(renewed.leaseUntil>a.availableAt);
  res=await post(f.env,'/v1/work/finish',{id:a.id,workerId:'host-1',leaseToken:a.leaseToken,ok:true,result:{file:'alpha.jpg'}});
  assert.equal((await res.json()).job.status,'done');
  assert.equal((await post(f.env,'/v1/work/finish',{id:a.id,workerId:'host-1',leaseToken:a.leaseToken,ok:true})).status,409);
  const discover=(await (await post(f.env,'/v1/work/claim',{runId,role:'discovery',workerId:'discover-1'})).json()).job;
  assert.equal(discover.subject,'seed');
  const stats=(await (await request(f.env,'/v1/work/stats?runId='+runId)).json());
  assert.equal(stats.jobs.catalog.done,1);assert.equal(stats.jobs.catalog.leased,1);
  assert.equal(stats.jobs.discovery.leased,1);
  const health=(await (await request(f.env,'/health',{token:'none'})).json());
  assert.equal(health.schemaVersion,3);assert.equal(health.workforceReady,true);
 }finally{f.close();}
});
test('expired lease is recovered by another worker and failures back off per ticket',async()=>{
 const f=fixture();try{
  await post(f.env,'/v1/work/jobs',{runId,jobs:[ticket('pragmatic','alpha'),ticket('playtech','beta')]});
  const first=(await (await post(f.env,'/v1/work/claim',{runId,role:'catalog',workerId:'first'})).json()).job;
  f.sqlite.prepare("UPDATE workforce_jobs SET lease_until=? WHERE id=?").run(Math.floor(Date.now()/1000)-10,first.id);
  const recovered=(await (await post(f.env,'/v1/work/claim',{runId,role:'catalog',provider:first.provider,workerId:'second'})).json()).job;
  assert.equal(recovered.id,first.id);assert.notEqual(recovered.leaseToken,first.leaseToken);
  // Provider-filtered recovery is deterministic even when another provider has fresh work.
  assert.equal((await post(f.env,'/v1/work/renew',{id:first.id,workerId:'first',leaseToken:first.leaseToken})).status,409);
  const failed=(await (await post(f.env,'/v1/work/finish',{id:recovered.id,workerId:'second',leaseToken:recovered.leaseToken,ok:false,error:'public demo timed out'})).json()).job;
  assert.equal(failed.status,'pending');assert.ok(failed.availableAt>Math.floor(Date.now()/1000));
  const other=(await (await post(f.env,'/v1/work/claim',{runId,role:'catalog',workerId:'third'})).json()).job;
  assert.notEqual(other.id,first.id,'failed ticket must not be immediately re-leased');
  assert.deepEqual(new Set([other.subject,first.subject]),new Set(['alpha','beta']));
 }finally{f.close();}
});
test('registration and job backlog are isolated by run/provider and require REVIEW bearer',async()=>{
 const f=fixture();try{
  await post(f.env,'/v1/work/jobs',{runId,jobs:[ticket('pragmatic','alpha'),ticket('playtech','beta')]});
  assert.equal((await post(f.env,'/v1/work/agent',{runId,workerId:'agent-one',role:'catalog',host:'windows-pc',capacity:2})).status,200);
  assert.equal((await post(f.env,'/v1/work/agent',{runId,workerId:'agent-two',role:'classification',host:'windows-pc'})).status,200);
  let s=(await (await request(f.env,'/v1/work/stats?runId='+runId)).json());
  assert.equal(s.activeAgents.catalog.workers,1);assert.equal(s.activeAgents.catalog.capacity,2);
  assert.equal(s.activeAgents.classification.workers,1);
  assert.equal((await (await post(f.env,'/v1/work/claim',{runId,role:'catalog',provider:'playtech',workerId:'agent-one'})).json()).job.provider,'playtech');
  assert.equal((await (await request(f.env,'/v1/work/stats?runId=other-run')).json()).jobs.catalog.pending,0);
 }finally{f.close();}
});
test('structured classifier never guesses from pixels or clicks reject cookies',()=>{
 const base={mode:'structured',adapter:'pragmatic-runtime',state:'BASE',candidates:[
  {id:'buy',source:'runtime',path:'Game/FeaturePurchase/FSPurchaseButton/Collider',label:'BUY FREE SPINS',confidence:.93,rect:{x:.1,y:.1,w:.2,h:.2}},
  {id:'spin',source:'runtime',path:'Game/NormalSpin',label:'Spin',confidence:.99,rect:{x:.6,y:.6,w:.1,h:.1}}]};
 assert.deepEqual(classifyStructured(base).selections,[{candidateId:'buy',kind:'buy'}]);
 const confirm={...base,state:'CONFIRM',candidates:[
  {id:'no',source:'runtime',label:'BUY / FREE',path:'Game/FeaturePurchase/Buttons/ButtonNo',confidence:.99,rect:{x:.1,y:.1,w:.1,h:.1}},
  {id:'yes',source:'runtime',label:'BUY / FREE',path:'Game/FeaturePurchase/Buttons/ButtonYes',confidence:.99,rect:{x:.4,y:.4,w:.1,h:.1}}]};
 assert.deepEqual(classifyStructured(confirm).selections,[{candidateId:'yes',kind:'buy'}]);
 assert.equal(classifyStructured({...base,mode:'hybrid'}).eligible,false);
 assert.equal(classifyStructured({...base,adapter:'opaque-canvas'}).status,'needs_review');
 assert.equal(classifyStructured({...base,candidates:[]}).status,'needs_review');
});
test('allocation reacts to roles and keeps browser capacity bounded',()=>{
 const initial={jobs:{discovery:{pending:8,leased:0},catalog:{pending:18,leased:0}},captures:{structured:12,visual:25,hybrid:5,needsReview:2},
  actionableClassifications:90};
 const x=planWorkforce(initial,{maxWorkers:5,browserWorkers:3});
 assert.ok(x.roles.discovery>0&&x.roles.catalog>0&&x.roles.classification>0&&x.roles.branches>0);
 assert.equal(Object.values(x.roles).reduce((a,b)=>a+b,0),5);
 assert.ok(x.browserWorkers<=3);assert.equal(x.visualReviewBacklog,30);
 const onlyClass=planWorkforce({jobs:{discovery:{pending:0},catalog:{pending:0}},captures:{structured:12},
  actionableClassifications:0},{maxWorkers:5,browserWorkers:3});
 assert.equal(onlyClass.roles.classification,2);
 assert.equal(onlyClass.roles.catalog+onlyClass.roles.discovery+onlyClass.roles.branches,0);
 assert.throws(()=>planWorkforce(initial,{maxWorkers:999}),/maxWorkers/);
});
test('catalogue discovery only accepts explicit, same-origin public demo links',()=>{
 const source={id:'example-public',provider:'pragmatic',enabled:true,approved:true,verifiedDemo:true,
  indexUrls:['https://www.pragmaticplay.fun/en/slots/'],gameUrlPrefix:'https://www.pragmaticplay.fun/en/slots/',
  gamePathPattern:'^/en/slots/[a-z0-9-]+/$'};
 const links=['https://www.pragmaticplay.fun/en/slots/game-a/','https://www.pragmaticplay.fun/en/slots/game-b/',
  'http://www.pragmaticplay.fun/en/slots/game-c/','https://casino.example/en/slots/malicious/',
  'https://www.pragmaticplay.fun/en/slots/game-d/?token=secret',
  'https://www.pragmaticplay.fun/admin/','https://www.pragmaticplay.fun/en/slots/game-a/'];
 const games=selectPublicDemoLinks(links,source);
 assert.deepEqual(games.map(x=>x.gameId),['game-a','game-b']);
 assert.throws(()=>validateDiscoverySource({...source,approved:false}),/approved/);
 assert.throws(()=>validateDiscoverySource({...source,indexUrls:['http://localhost/']}),/public HTTPS|non-public/);
});
test('claim mode filter lets structured workers coexist with visual MCP reviewers',async()=>{
 const f=fixture();try{
  const mk=(gameId,mode)=>({runId,provider:'pragmatic',gameId,shotId:'base',state:'BASE',
   mode,adapter:'test',candidates:mode==='structured'?[{id:'c0',label:'BUY FEATURE',source:'runtime',role:'button',confidence:.9,rect:{x:.1,y:.1,w:.2,h:.2}}]:[],
   metadata:{source:'fixture'}});
  // Upload structured through JSON. The visual item uses the same old JPEG API.
  await postIngest(f.env,mk('structured-game','structured'));
  const form=new FormData();form.set('metadata',JSON.stringify(mk('visual-game','visual')));form.set('image',new Blob([new Uint8Array([255,216,1,2,255,217])],{type:'image/jpeg'}),'a.jpg');
  const visual=await worker.fetch(new Request('https://worker.example/v1/items',{method:'POST',headers:{Authorization:'Bearer ingest-test'},body:form}),f.env);
  assert.equal(visual.status,201);
  const claim=(await (await post(f.env,'/v1/claim',{runId,mode:'structured'})).json()).item;
  assert.equal(claim.gameId,'structured-game');
  const next=(await (await post(f.env,'/v1/claim',{runId,mode:'structured'})).json()).item;
  assert.equal(next,null);
  const image=(await (await post(f.env,'/v1/claim',{runId,mode:'visual'})).json()).item;
  assert.equal(image.gameId,'visual-game');
 }finally{f.close();}
});
async function postIngest(env,payload){
 const response=await request(env,'/v1/items',{method:'POST',body:payload,token:'ingest-test'});
 assert.equal(response.status,201);
}

test('discovery task identity matches the periodic source bucket in the worker',()=>{
 const source={id:'playtech-catalogue',provider:'playtech',enabled:true,approved:true,verifiedDemo:false,
  indexUrls:['https://public.example.org/demos/'],gameUrlPrefix:'https://public.example.org/demos/',
  gamePathPattern:'^/demos/[a-z0-9-]+/$'};
 const ticket={role:'discovery',provider:'playtech',
  subject:discoveryTicketSubject(source.id,12345),payload:{source}};
 assert.equal(validateDiscoveryTicket(ticket),source);
 assert.throws(()=>validateDiscoveryTicket({...ticket,provider:'pragmatic'}),/identity mismatch/);
 assert.throws(()=>validateDiscoveryTicket({...ticket,subject:source.id}),/identity mismatch/);
 assert.throws(()=>validateDiscoveryTicket({...ticket,subject:source.id+'-foobar'}),/identity mismatch/);
 assert.throws(()=>discoveryTicketSubject('x'.repeat(76),12345),/75/);
});
