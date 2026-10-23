import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {CloudClient} from '../local/cloud-client.js';
import {LoopController} from '../local/loop.js';

const item={id:'r:pragmatic:alpha:base',runId:'r',provider:'pragmatic',gameId:'alpha',shotId:'base',status:'classified',sourceSha256:'a'.repeat(64),revision:2,state:'BASE',mode:'structured',candidates:[{id:'c0',label:'Buy A',path:'G/A'}],metadata:{url:'https://www.pragmaticplay.fun/en/slots/alpha/'},decisions:{allMarks:[{candidateId:'c0',label:'Buy A',kind:'buy',x:.5,y:.5},{label:'Buy B',kind:'buy',x:.7,y:.5}]}};
const feed=[{id:item.id,revision:item.revision,sourceSha256:item.sourceSha256,decisions:item.decisions}];
const jpeg=Buffer.from([255,216,3,4,5,255,217]);
async function temp(){return fs.mkdtemp(path.join(os.tmpdir(),'hybrid-loop-'));}
test('cloud client paginates and authenticates review separately from ingest',async()=>{
 const calls=[];const client=new CloudClient({endpoint:'https://demo.workers.dev',reviewToken:'review',ingestToken:'ingest',fetcher:async(u,opts)=>{
  calls.push([u,opts.headers.Authorization]);const url=new URL(u);
  if(url.pathname==='/v1/decisions')return new Response(JSON.stringify({items:url.searchParams.get('after')==='0'?feed:[],nextAfter:3}));
  if(url.pathname.startsWith('/v1/items/'))return new Response(JSON.stringify({item}));
  if(url.pathname==='/v1/stats')return new Response(JSON.stringify({counts:{pending:0,leased:0,classified:1,needs_review:0}}));
  if(url.pathname==='/v1/items'&&opts.method==='POST')return new Response(JSON.stringify({item:{id:'r:pragmatic:alpha:step-test',gameId:'alpha'}}),{status:201});
  throw Error('unexpected '+url.pathname);
 }});
 assert.equal((await client.allDecisions('r')).length,1);assert.equal((await client.item(item.id)).id,item.id);
 assert.equal((await client.stats('r')).classified,1);
 const capture={runId:'r',provider:'pragmatic',gameId:'alpha',shotId:'step-test',state:'BASE',mode:'structured',candidates:[{id:'c0'}]};
 await client.uploadCapture(capture,jpeg);
 assert.ok(calls.some(c=>c[1]==='Bearer review'));assert.ok(calls.some(c=>c[1]==='Bearer ingest'));
});
test('each game executes only one sibling branch per polling cycle with durable journal',async()=>{
 const dir=await temp();let calls=0,published=[];
 const cloud={stats:async()=>({pending:0,leased:0,needs_review:0,classified:1}),blockedGames:async()=>new Set(),allDecisions:async()=>feed,item:async()=>item,
   uploadCapture:async(info,image)=>{published.push(info);assert.ok(image.length);return {item:{id:`${info.runId}:${info.provider}:${info.gameId}:${info.shotId}`,gameId:info.gameId,shotId:info.shotId}};},
   uploadTrace:async()=>({ok:true})};
 const executor=async task=>{calls++;return {info:{runId:task.runId,provider:task.provider,gameId:task.gameId,shotId:task.shotId,state:'BUY_MENU',mode:'visual',adapter:'test',candidates:[],width:640,height:360,metadata:{url:'https://www.pragmaticplay.fun/en/slots/alpha/',actionPath:task.path}},image:jpeg,trace:{log:{entries:[],_webSockets:[]}}};};
 try{
  const config={cloud,runId:'r',executor,outDir:dir,limit:20};
  assert.equal((await new LoopController(config).once()).completed,1);
  assert.equal(calls,1);
  assert.equal((await new LoopController(config).once()).completed,1);
  assert.equal(calls,2);assert.equal(published.length,2);assert.notEqual(published[0].shotId,published[1].shotId);
  assert.equal((await new LoopController(config).once()).completed,0);assert.equal(calls,2);
  const state=JSON.parse(await fs.readFile(path.join(dir,'.round-journal.json')));assert.equal(Object.values(state.entries).filter(e=>e.status==='done').length,2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('one game waits while its own new child remains unclassified',async()=>{
 const dir=await temp();try{
  const controller=new LoopController({runId:'r',outDir:dir,cloud:{stats:async()=>({pending:1,leased:0,needs_review:0,classified:1}),blockedGames:async()=>new Set(['pragmatic/alpha']),allDecisions:async()=>feed,item:async()=>item},executor:async()=>{throw Error('should wait')}});
  const answer=await controller.once();assert.equal(answer.waiting,true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('failed capture after action is not blindly repeated on restart',async()=>{
 const dir=await temp();let calls=0;const cloud={stats:async()=>({pending:0,leased:0,needs_review:0,classified:1}),blockedGames:async()=>new Set(),allDecisions:async()=>feed,item:async()=>item};
 const executor=async()=>{calls++;throw Error('browser lost');};
 try{
  const config={cloud,runId:'r',executor,outDir:dir,limit:1};const first=await new LoopController(config).once();assert.equal(first.blocked,1);
  await new LoopController(config).once();assert.equal(calls,1);await new LoopController(config).once();assert.equal(calls,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
