import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LoopController} from '../local/loop.js';
import {CloudClient} from '../local/cloud-client.js';

const jpg=Buffer.from([255,216,3,7,255,217]);
const runId='per-game-run';
const item=(gameId,shotId='base',options={})=>({
 id:runId+':pragmatic:'+gameId+':'+shotId,runId,provider:'pragmatic',gameId,shotId,
 revision:2,sourceSha256:'f'.repeat(64),status:'classified',state:'BASE',
 candidates:[{id:'c0',label:'Buy',path:'Root/Buy',rect:{x:.1,y:.1,w:.2,h:.2},confidence:.92}],
 metadata:{url:'https://www.pragmaticplay.fun/en/slots/'+gameId+'/'},
 decisions:{allMarks:[{kind:'buy',label:'Buy',candidateId:'c0',x:.2,y:.2}]},...options
});
const feedFor=items=>items.map(i=>({id:i.id,runId,provider:i.provider,gameId:i.gameId,revision:i.revision,sourceSha256:i.sourceSha256,decisions:i.decisions}));
function fakeCloud(items,{blocked=[],failUploadFor=null}={}){
 const map=new Map(items.map(i=>[i.id,i]));const calls=[];const published=[];
 return {calls,published,
  stats:async()=>({pending:1,leased:0,needs_review:1,classified:items.length}),
  blockedGames:async()=>new Set(blocked),
  allDecisions:async()=>feedFor([...map.values()].filter(i=>i.status==='classified')),
  item:async id=>map.get(id),
  uploadCapture:async info=>{
   calls.push({type:'upload',gameId:info.gameId});
   if(info.gameId===failUploadFor)throw Error('network outage for '+info.gameId);
   published.push(info);
   return {item:{id:info.runId+':'+info.provider+':'+info.gameId+':'+info.shotId,shotId:info.shotId,gameId:info.gameId}};
  },
  uploadTrace:async()=>({ok:true}),
  setBlocked(values){blocked=[...values]},
  add(i){map.set(i.id,i);}
 };
}
function fakeExec(log){
 return async task=>{log.push(task);return {
  info:{runId:task.runId,provider:task.provider,gameId:task.gameId,shotId:task.shotId,
   state:'BASE',mode:'visual',adapter:'fixture',width:1024,height:576,
   candidates:[],metadata:{url:'https://www.pragmaticplay.fun/en/slots/'+task.gameId+'/',actionPath:task.path}},
  image:jpg,trace:{log:{version:'1.2',entries:[],_webSockets:[],_notice:'Sanitized DEMO diagnostics'}}
 }};
}

test('independent games overlap their waits and persist every concurrent journal entry',async()=>withDir(async outDir=>{
 const cloud=fakeCloud([item('alpha'),item('beta'),item('gamma')]);
 let active=0,peak=0,release;
 const barrier=new Promise(resolve=>{release=resolve;});
 const executor=async task=>{
  active++;peak=Math.max(peak,active);if(active===3)release();
  await barrier;active--;
  return fakeExec([])(task);
 };
 const timeout=setTimeout(()=>release(),1000);
 try{
  const result=await new LoopController({cloud,executor,runId,outDir,concurrency:3,log:()=>{}}).once();
  assert.equal(peak,3);assert.equal(result.completed,3);
  const saved=JSON.parse(await fs.readFile(path.join(outDir,'.round-journal.json'),'utf8'));
  assert.equal(Object.keys(saved.entries).length,3);assert.ok(Object.values(saved.entries).every(e=>e.status==='done'));
 }finally{clearTimeout(timeout);}
}));

test('a busy provider defers without reserving or poisoning that game in the execution journal',async()=>withDir(async outDir=>{
 const cloud=fakeCloud([item('alpha'),item('beta')]);let available=false,releases=0;
 const worker=new LoopController({cloud,runId,outDir,log:()=>{},executor:fakeExec([]),
  reserve:async task=>task.gameId==='alpha'&&!available?{deferred:true}:{permit:true},release:async()=>releases++});
 const first=await worker.once();assert.equal(first.completed,1);assert.equal(first.deferred,1);assert.equal(releases,1);
 available=true;assert.equal((await worker.once()).completed,1);assert.equal(releases,2);
}));
async function withDir(fn){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'game-isolation-'));
 try{return await fn(dir);}finally{await fs.rm(dir,{force:true,recursive:true});}
}
test('the reviewer can leave game A in needs_review while games B and C generate branches',async()=>withDir(async outDir=>{
 const a=item('alpha'),b=item('beta'),c=item('gamma');
 const cloud=fakeCloud([a,b,c],{blocked:['pragmatic/alpha']});const attempted=[];
 const controller=new LoopController({runId,cloud,executor:fakeExec(attempted),outDir,limit:5,log:()=>{}});
 const first=await controller.once();
 assert.deepEqual(attempted.map(t=>t.gameId),['beta','gamma']);
 assert.equal(first.completed,2);assert.equal(first.blockedGames,1);
 assert.equal(cloud.published.length,2);
 assert.equal((await controller.once()).completed,0);
}));
test('pending classification for a child blocks only its own game until it is classified',async()=>withDir(async outDir=>{
 const a=item('alpha'),b=item('beta'),cloud=fakeCloud([a,b],{blocked:['pragmatic/alpha']});
 const attempted=[];const ctrl=new LoopController({runId,cloud,executor:fakeExec(attempted),outDir,limit:10,log:()=>{}});
 assert.equal((await ctrl.once()).completed,1);
 assert.deepEqual(attempted.map(x=>x.gameId),['beta']);
 cloud.setBlocked(['pragmatic/beta']);
 assert.equal((await ctrl.once()).completed,1);
 assert.deepEqual(attempted.map(x=>x.gameId),['beta','alpha']);
}));
test('failed R2/D1 upload stays in the local journal and cannot stall another game',async()=>withDir(async outDir=>{
 const a=item('alpha'),b=item('beta'),cloud=fakeCloud([a,b],{failUploadFor:'alpha'}),attempted=[];
 const ctrl=new LoopController({runId,cloud,executor:fakeExec(attempted),outDir,limit:10,log:()=>{}});
 const first=await ctrl.once();
 assert.equal(first.completed,1);
 assert.equal(first.blocked,1);
 assert.deepEqual(attempted.map(x=>x.gameId).sort(),['alpha','beta']);
 assert.deepEqual(cloud.published.map(x=>x.gameId),['beta']);
 const second=await ctrl.once();
 assert.equal(second.completed,0);
 assert.equal(attempted.length,2,'never re-click already captured or completed branches');
 const j=JSON.parse(await fs.readFile(path.join(outDir,'.round-journal.json'),'utf8'));
 assert.equal(Object.values(j.entries).some(e=>e.task.gameId==='alpha'&&e.status==='captured'),true);
}));
test('one changed or missing classification does not cancel other games',async()=>withDir(async outDir=>{
 const a=item('alpha'),b=item('beta'),cloud=fakeCloud([a,b]);const attempted=[];
 const oldItem=cloud.item;cloud.item=async id=>id===a.id?{...a,revision:3,status:'pending'}:oldItem(id);
 const ctrl=new LoopController({runId,cloud,executor:fakeExec(attempted),outDir,limit:5,log:()=>{}});
 const result=await ctrl.once();
 assert.equal(result.completed,1);
 assert.equal(result.blockedGames,1);
 assert.deepEqual(attempted.map(x=>x.gameId),['beta']);
}));
test('do not execute tasks if the per-game readiness feed is unavailable',async()=>withDir(async outDir=>{
 const a=item('alpha'),cloud=fakeCloud([a]),attempted=[];
 cloud.blockedGames=async()=>{throw Error('Cloudflare unavailable')};
 const ctrl=new LoopController({runId,cloud,executor:fakeExec(attempted),outDir,limit:5,log:()=>{}});
 await assert.rejects(()=>ctrl.once(),/Cloudflare unavailable/);
 assert.equal(attempted.length,0);
}));
test('sibling choices are processed in separate rounds so an unclassified child pauses its own game',async()=>withDir(async outDir=>{
 const a=item('alpha','base',{decisions:{allMarks:[{kind:'buy',label:'Buy A',x:.2,y:.2},{kind:'buy',label:'Buy B',x:.3,y:.2}]}});
 const b=item('beta');const cloud=fakeCloud([a,b]);const attempted=[];
 const ctrl=new LoopController({runId,cloud,executor:fakeExec(attempted),outDir,limit:5,log:()=>{}});
 const first=await ctrl.once();
 assert.equal(first.completed,2);
 assert.deepEqual(attempted.map(t=>t.gameId),['alpha','beta']);
 cloud.setBlocked(['pragmatic/alpha']);
 const second=await ctrl.once();assert.equal(second.completed,0);
 cloud.setBlocked([]);
 const third=await ctrl.once();assert.equal(third.completed,1);
 assert.equal(attempted[2].gameId,'alpha');
}));
test('game blocker pagination and authorization in the Cloudflare client',async()=>{
 const urls=[],client=new CloudClient({endpoint:'https://example.workers.dev',reviewToken:'review',ingestToken:'ingest',
  fetcher:async(u,options)=>{
   urls.push({url:u,authorization:options.headers.Authorization});
   const parsed=new URL(u);if(parsed.pathname!=='/v1/game-blockers')throw Error('unexpected route');
   const after=parsed.searchParams.get('after')||'';
   return new Response(JSON.stringify(after?{items:[{provider:'playtech',gameId:'g3',pending:0,leased:0,needs_review:1}],nextAfter:'playtech/g3',hasMore:false}:{items:[{provider:'pragmatic',gameId:'alpha',pending:1,leased:0,needs_review:0}],nextAfter:'pragmatic/alpha',hasMore:true}));
  }});
 const blocked=await client.blockedGames(runId);
 assert.deepEqual([...blocked],['pragmatic/alpha','playtech/g3']);
 assert.equal(urls.length,2);
 assert.ok(urls.every(r=>r.authorization==='Bearer review'));
});
test('client fails closed when game blockers cannot be enumerated completely',async()=>{
 const client=new CloudClient({endpoint:'https://example.workers.dev',reviewToken:'review',ingestToken:'ingest',
  fetcher:async()=>new Response(JSON.stringify({items:[{provider:'pragmatic',gameId:'alpha',pending:1}],nextAfter:'pragmatic/alpha',hasMore:true}))});
 await assert.rejects(()=>client.blockedGames(runId),/cursor|advance/i);
});
