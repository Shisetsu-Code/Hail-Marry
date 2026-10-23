import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {stageCapture,instructCapture,takeCaptureCommand,reviewRow,captureTiming} from '../src/capture-review.js';import {ingest} from '../src/core.js';
import worker from '../src/worker.js';
const jpeg=new Uint8Array([255,216,1,2,255,217]).buffer;
function fixture(){const db=new DatabaseSync(':memory:');for(const m of ['0001_init','0006_capture_reviews'])db.exec(fs.readFileSync(new URL('../migrations/'+m+'.sql',import.meta.url),'utf8'));const objects=new Map();return {db,env:{DB:{prepare(sql){const statement=db.prepare(sql);const bound=args=>({first:async()=>statement.get(...args)||null,run:async()=>({meta:statement.run(...args)}),all:async()=>({results:statement.all(...args)})});return {...bound([]),bind:(...args)=>bound(args)};}},IMAGES:{put:async(k,v)=>objects.set(k,v),get:async k=>objects.has(k)?{arrayBuffer:async()=>objects.get(k),text:async()=>String(objects.get(k))}:null}}};}
const identity={runId:'test',provider:'p',gameId:'g',shotId:'base',sessionId:'session-one'};
const command=(r,extra={})=>({id:r.id,sessionId:r.sessionId,revision:r.revision,imageSha256:r.imageSha256,action:'wait',waitMs:1000,reason:'Still loading',reviewer:'GPT',...extra});
test('same batch quality loop: pending images invisible to queue; one command; exact image approval required',async()=>{const f=fixture();try{
 const first=await stageCapture(f.env,identity,jpeg);assert.equal(f.db.prepare('SELECT count(*) n FROM items').get().n,0);
 await assert.rejects(instructCapture(f.env,command(first,{imageSha256:'bad'})));
 await instructCapture(f.env,command(first,{action:'click',x:.5,y:.8,initialWaitMs:45000}));
 assert.equal((await captureTiming(f.env,identity)).waitMs,45000);
 assert.equal((await captureTiming(f.env,{provider:'p',gameId:'other'})).waitMs,25000);
 await assert.rejects(instructCapture(f.env,command(first)));
 const take=await takeCaptureCommand(f.env,{id:first.id,sessionId:identity.sessionId,revision:first.revision,imageSha256:first.imageSha256});assert.equal(take.action.kind,'click');
 assert.equal((await takeCaptureCommand(f.env,{id:first.id,sessionId:identity.sessionId,revision:first.revision,imageSha256:first.imageSha256})).action,null);
 assert.equal((await takeCaptureCommand(f.env,{id:first.id,sessionId:'another-session'})).action,null);
 const second=await stageCapture(f.env,{...identity,revision:first.revision,commandId:take.action.id},jpeg);assert.equal(second.id,first.id);assert.equal(second.revision,2);
 await assert.rejects(instructCapture(f.env,command(first,{action:'approve'})));
 const info={...identity,mode:'visual',state:'BASE',adapter:'gpt-quality',width:640,height:480,candidates:[],metadata:{source:'github-actions-catalogue',captureValidation:{reviewId:second.id,revision:second.revision,status:'ready'}}};
 await assert.rejects(ingest(f.env,info,jpeg));
 await instructCapture(f.env,command(second,{action:'approve'}));
 const item=await ingest(f.env,info,jpeg);assert.equal(item.status,'pending');
 assert.equal(f.db.prepare('SELECT count(*) n FROM decision_history').get().n,0);
 assert.equal((await stageCapture(f.env,{...identity,sessionId:'next-session'},jpeg)).status,'approved');
 assert.equal((await reviewRow(f.env,first.id)).status,'approved');
 }finally{f.db.close();}});
test('offline GPT feedback persists until a fresh runner claims it, without losing pending images',async()=>{const f=fixture();try{
 const first=await stageCapture(f.env,identity,jpeg);assert.equal(first.expiresAt,0);
 await instructCapture(f.env,command(first,{action:'click',x:.4,y:.7}));
 await assert.rejects(stageCapture(f.env,{...identity,sessionId:'next-session'},jpeg));
 const claimed=await takeCaptureCommand(f.env,{id:first.id,sessionId:'next-session',revision:first.revision,imageSha256:first.imageSha256});
 assert.equal(claimed.action.kind,'click');assert.equal(claimed.sessionId,'next-session');
 const fresh=await stageCapture(f.env,{...identity,sessionId:'next-session',revision:claimed.revision,commandId:claimed.action.id},jpeg);assert.equal(fresh.status,'pending');assert.equal(fresh.action,null);assert.equal(fresh.history[0].action.kind,'click');
 await assert.rejects(instructCapture(f.env,command(first,{action:'approve'})));
 }finally{f.db.close();}});
test('concurrent command delivery authorizes at most one execution',async()=>{const f=fixture();try{
 const review=await stageCapture(f.env,identity,jpeg);await instructCapture(f.env,command(review,{action:'click',x:.5,y:.5}));
 const calls=await Promise.allSettled([1,2].map(()=>takeCaptureCommand(f.env,{id:review.id,sessionId:identity.sessionId,revision:review.revision,imageSha256:review.imageSha256})));
 assert.equal(calls.filter(r=>r.status==='fulfilled'&&r.value.action?.kind==='click').length,1);
 }finally{f.db.close();}});
test('HTTP staging and MCP quality review require distinct existing credentials',async()=>{const f=fixture();try{
 Object.assign(f.env,{INGEST_TOKEN:'ingest',MCP_TOKEN:'mcp',REVIEW_TOKEN:'review'});
 const form=()=>{const value=new FormData();value.set('metadata',JSON.stringify(identity));value.set('image',new Blob([jpeg]),'demo.jpg');return value;};
 const upload=token=>worker.fetch(new Request('https://test/v1/capture-reviews',{method:'POST',headers:{Authorization:'Bearer '+token},body:form()}),f.env);
 assert.equal((await upload('review')).status,401);const response=await upload('ingest');assert.equal(response.status,201);const review=(await response.json()).review;
 const rpc=async(name,args,token='mcp')=>worker.fetch(new Request('https://test/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),f.env);
 assert.equal((await rpc('capture_review_action',command(review),'ingest')).status,401);
 const list=await (await rpc('capture_reviews',{runId:'test'})).json();assert.equal(JSON.parse(list.result.content[0].text).items.length,1);
 const picture=await (await rpc('capture_review_image',{id:review.id})).json();assert.equal(picture.result.content[1].mimeType,'image/jpeg');
 const act=await (await rpc('capture_review_action',command(review,{action:'approve'}))).json();assert.equal(act.result.isError,undefined);
 assert.equal(f.db.prepare('SELECT count(*) n FROM items').get().n,0);
 }finally{f.db.close();}});

test('GPT approval after runners exit promotes the saved image immediately and idempotently',async()=>{const f=fixture();try{
 const item={...identity,mode:'visual',state:'UNKNOWN',adapter:'test',width:640,height:480,candidates:[],metadata:{source:'github-actions-catalogue',captureReviewPath:[]}};
 const review=await stageCapture(f.env,{...identity,item},jpeg);
 assert.equal(f.db.prepare('SELECT count(*) n FROM items').get().n,0);
 const approved=await instructCapture(f.env,command(review,{action:'approve'}));assert.equal(approved.itemId,review.id);
 assert.equal(f.db.prepare('SELECT count(*) n FROM items').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM decision_history').get().n,0);
 await instructCapture(f.env,command(review,{action:'approve'}));assert.equal(f.db.prepare('SELECT count(*) n FROM items').get().n,1);
 }finally{f.db.close();}});
