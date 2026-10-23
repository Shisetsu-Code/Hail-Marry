import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
import {ingest,claim,save} from '../src/core.js';
import {makeTask} from '../local/rounds.js';
function fixture({migrate=true}={}){
 const sqlite=new DatabaseSync(':memory:');
 for(const name of ['0001_init.sql','0002_action_traces.sql',...(migrate?['0005_branch_executions.sql']:[])])sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const DB={prepare(sql){const stmt=sqlite.prepare(sql);const bound=args=>({query:sql,args,first:async()=>stmt.get(...args)||null,run:async()=>({meta:stmt.run(...args)}),all:async()=>({results:stmt.all(...args)})});return {...bound([]),bind:(...args)=>bound(args)};},async batch(stmts){sqlite.exec('BEGIN');try{const results=stmts.map(s=>({meta:sqlite.prepare(s.query).run(...s.args)}));sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 return {sqlite,env:{DB,IMAGES:{},INGEST_TOKEN:'ingest',REVIEW_TOKEN:'review',MCP_TOKEN:'mcp'}};
}
async function parent(env,gameId='alpha'){
 await ingest(env,{runId:'batch',provider:'pragmatic',gameId,shotId:'base',state:'BASE',mode:'structured',adapter:'test',candidates:[{id:'c0',label:'BUY BONUS',source:'runtime',role:'button',confidence:.95,rect:{x:.1,y:.2,w:.2,h:.2},path:'Game/Buy'}]});
 const item=await claim(env,{runId:'batch',provider:'pragmatic'});
 return save(env,{id:item.id,leaseId:item.leaseId,revision:item.revision,sourceSha256:item.sourceSha256,status:'classified',selections:[{candidateId:'c0',kind:'buy'}],reviewer:'test'});
}
async function request(env,path,body,token='review'){
 return worker.fetch(new Request('https://example.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
}
const claimBody=task=>({parentId:task.parentId,revision:task.parentRevision,sourceSha256:task.parentSourceSha256,actionIndex:task.actionIndex,taskId:task.id});
test('two hosts can reserve a reviewed branch only once; ownership and evidence are required',async()=>{
 const f=fixture();try{
  const item=await parent(f.env),task=makeTask(item,0),body=claimBody(task);
  assert.equal((await request(f.env,'/v1/branches/claim',body,'ingest')).status,401);
  const reservations=await Promise.all([request(f.env,'/v1/branches/claim',body),request(f.env,'/v1/branches/claim',body)]);
  const values=await Promise.all(reservations.map(r=>r.json()));assert.equal(values.filter(r=>r.acquired).length,1);
  const execution=values.find(r=>r.acquired);
  assert.equal((await request(f.env,'/v1/branches/finish',{taskId:task.id,token:'wrong',status:'blocked',reason:'test'})).status,409);
  assert.equal((await request(f.env,'/v1/branches/finish',{taskId:task.id,token:execution.token,status:'done',childId:'missing'})).status,409);
  assert.equal((await request(f.env,'/v1/branches/finish',{taskId:task.id,token:execution.token,status:'uncertain',reason:'lost after possible click'})).status,200);
  assert.equal((await (await request(f.env,'/v1/branches/claim',body)).json()).acquired,false);
  const rows=await (await request(f.env,'/v1/branches?runId=batch')).json();assert.equal(rows.items[0].status,'uncertain');assert.equal(rows.items[0].token,undefined);
 }finally{f.sqlite.close();}
});
test('unreviewed or stale sources and forged task identity cannot execute',async()=>{
 const f=fixture();try{
  const item=await parent(f.env),task=makeTask(item,0);
  for(const patch of [{revision:99},{sourceSha256:'b'.repeat(64)},{taskId:'c'.repeat(64)}])assert.equal((await request(f.env,'/v1/branches/claim',{...claimBody(task),...patch})).status,409);
  f.sqlite.prepare("UPDATE items SET status='needs_review' WHERE id=?").run(item.id);
  assert.equal((await request(f.env,'/v1/branches/claim',claimBody(task))).status,409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,0);
 }finally{f.sqlite.close();}
});
test('an unresolved capture blocks that game, but not another game',async()=>{
 const f=fixture();try{
  const a=await parent(f.env),b=await parent(f.env,'beta');
  f.sqlite.prepare("INSERT INTO items(id,run_id,provider,game_id,shot_id,state,mode,adapter,source_sha256) SELECT REPLACE(id,':base',':next'),run_id,provider,game_id,'next',state,mode,adapter,source_sha256 FROM items WHERE id=?").run(a.id);
  assert.equal((await (await request(f.env,'/v1/branches/claim',claimBody(makeTask(a,0)))).json()).acquired,false);
  assert.equal((await (await request(f.env,'/v1/branches/claim',claimBody(makeTask(b,0)))).json()).acquired,true);
 }finally{f.sqlite.close();}
});
test('missing migration refuses execution without breaking health',async()=>{
 const f=fixture({migrate:false});try{assert.equal((await request(f.env,'/v1/branches?runId=batch')).status,503);}finally{f.sqlite.close();}
});
test('a completed branch requires its linked capture and sanitized trace and stays done',async()=>{
 const f=fixture();try{
  const source=await parent(f.env),task=makeTask(source,0),execution=await (await request(f.env,'/v1/branches/claim',claimBody(task))).json();
  const child=await ingest(f.env,{runId:'batch',provider:'pragmatic',gameId:'alpha',shotId:task.shotId,state:'BUY_MENU',mode:'structured',adapter:'test',candidates:source.candidates,
   metadata:{parentId:source.id,parentRevision:source.revision,parentSourceSha256:source.sourceSha256,actionPath:task.path}});
  const trace={traceId:task.id,runId:'batch',provider:'pragmatic',gameId:'alpha',parentId:source.id,parentRevision:source.revision,parentSourceSha256:source.sourceSha256,childId:child.id,
   trace:{log:{entries:[],_webSockets:[],_notice:'Sanitized DEMO diagnostics'}}};
  f.env.IMAGES.put=async()=>{};
  assert.equal((await request(f.env,'/v1/traces',trace,'ingest')).status,201);
  const finish={taskId:task.id,token:execution.token,status:'done',childId:child.id};
  assert.equal((await request(f.env,'/v1/branches/finish',finish)).status,200);
  assert.equal((await (await request(f.env,'/v1/branches/finish',finish)).json()).unchanged,true);
  assert.equal((await (await request(f.env,'/v1/branches/claim',claimBody(task))).json()).status,'done');
 }finally{f.sqlite.close();}
});
