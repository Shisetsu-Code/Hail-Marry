import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GuidedStore } from '../store.mjs';

const mod=await import('../server.mjs').catch(()=>({}));
const key='test-key-that-is-long-enough-for-authentication';
const hash=value=>createHash('sha256').update(value).digest('hex');
const ref=game=>({screenId:game.screen.id,revision:game.screen.revision,imageSha256:game.screen.imageSha256});
async function setup(t) {
  assert.equal(typeof mod.createClassifierServer,'function','HTTP server must exist');
  const directory=await mkdtemp(path.join(os.tmpdir(),'guided-server-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const targets=[{id:'one',provider:'fixture'}];
  const store=await GuidedStore.open({directory,runId:'test-server',targets});
  let count=0;
  const observation=()=>{const image=Buffer.from('image-'+count);return {image,imageSha256:hash(image),sessionId:'session-one',width:800,height:600,at:new Date().toISOString(),candidates:[],state:{}};};
  await store.capture('one',observation());
  const performed=[];
  const runner={observe:async()=>observation(),perform:async(id,input)=>{
    const before=observation(); performed.push(input); count++; return {before,after:observation(),inputDispatched:true,confirmation:{status:'pending',reason:'input-only'},network:[]};
  }};
  const server=mod.createClassifierServer({store,runner,tokenHash:hash(key),publicDir:path.resolve('classifier/public')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(url,body,method='POST',auth=true)=>{
    const response=await fetch(base+url,{method,headers:{...(auth?{authorization:'Bearer '+key}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};
  };
  return {store,runner,performed,request,base,server};
}
test('API and images require the bearer key; health contains no secret',async t=>{
  const {request,store,base}=await setup(t);
  assert.equal((await request('/api/state',null,'GET',false)).status,401);
  const image=await fetch(base+store.game('one').screen.imageUrl);
  assert.equal(image.status,401);
  assert.equal((await request('/api/state',null,'GET')).status,200);
  assert.ok(!(await (await fetch(base+'/health')).text()).includes(key));
});
test('5 finishes without input and duplicate mutation is idempotent even after completion',async t=>{
  const {request,store,performed}=await setup(t);
  const body={...ref(store.game('one')),requestId:'req-only-spin',mode:'spin_only',x:.8,y:.8,execute:true};
  assert.equal((await request('/api/games/one/mark',body)).status,200);
  assert.equal((await request('/api/games/one/mark',body)).status,200);
  assert.equal(store.game('one').controls.length,1); assert.equal(performed.length,0);
  assert.equal(store.game('one').finished,true);
});
test('Q advances once, links the child capture, and preserves pending rather than fake success',async t=>{
  const {request,store,performed}=await setup(t);
  const before=store.game('one').screen;
  const body={...ref(store.game('one')),requestId:'req-continue',mode:'continue',x:.5,y:.5,execute:true};
  assert.equal((await request('/api/games/one/mark',body)).status,200);
  assert.equal((await request('/api/games/one/mark',body)).status,200);
  const game=store.game('one');
  assert.equal(performed.length,1); assert.equal(game.screen.parentScreenId,before.id);
  assert.equal(game.actions[0].inputDispatched,true); assert.equal(game.actions[0].confirmation.status,'pending');
  assert.equal(game.screen.route[0],game.controls[0].id);
});
test('stale capture rejects before input and ante uses the explicitly linked spin',async t=>{
  const {request,store,performed}=await setup(t);
  const identity=ref(store.game('one'));
  assert.equal((await request('/api/games/one/mark',{...identity,requestId:'req-stale-ref',revision:0,mode:'buy',x:.5,y:.5,execute:true})).status,409);
  assert.equal(performed.length,0);
  assert.equal((await request('/api/games/one/mark',{...identity,requestId:'req-spin-mark',mode:'spin',x:.9,y:.8,execute:true})).status,200);
  const spin=store.game('one').spinControlId;
  assert.equal((await request('/api/games/one/mark',{...identity,requestId:'req-ante-mark',mode:'antebet',x:.4,y:.8,execute:true})).status,200);
  assert.deepEqual(performed.map(p=>p.control.mode),['antebet','spin']);
  assert.equal(performed[1].control.id,spin); assert.equal(performed[1].scope,'target');
  assert.equal(performed[1].control.linkedAnteControlId,performed[0].control.id);
});
test('a post-dispatch capture failure stays pending and requires refresh before another input',async t=>{
  const {request,store,runner}=await setup(t);
  runner.perform=async()=>({after:null,inputDispatched:true,confirmation:{status:'pending',reason:'capture failed'},network:[]});
  const first=await request('/api/games/one/mark',{...ref(store.game('one')),requestId:'req-capture-fail',mode:'buy',x:.5,y:.5,execute:true});
  assert.equal(first.status,200); assert.equal(store.game('one').requiresReview,true);
  assert.equal(store.game('one').actions[0].inputDispatched,true);
  const second=await request('/api/games/one/mark',{...ref(store.game('one')),requestId:'req-block-repeat',mode:'buy',x:.5,y:.5,execute:true});
  assert.equal(second.status,409);
  const action=store.game('one').actions[0];
  assert.equal((await request('/api/games/one/refresh',{...ref(store.game('one')),requestId:'req-reconcile-image'})).status,200);
  const after=store.game('one');
  assert.equal(after.screen.viaControlId,action.controlId);
  assert.equal(after.screen.route.at(-1),action.controlId);
  assert.equal(after.actions[0].toScreenId,after.screen.id);
});
test('unknown dispatch never becomes a definitely unsent retryable purchase',async t=>{
  const {request,store,runner}=await setup(t);
  runner.perform=async()=>{throw new Error('transport lost after dispatch may have occurred');};
  const result=await request('/api/games/one/mark',{...ref(store.game('one')),requestId:'req-unknown-dispatch',mode:'buy',x:.5,y:.5,execute:true});
  assert.equal(result.status,409);
  assert.equal(store.game('one').requiresReview,true);
  assert.equal(store.game('one').actions[0].inputDispatched,null);
  assert.ok(!result.data.error.includes('No se envió'));
});
test('uncertain transport result stays explicit in the recovered route graph',async t=>{
  const {request,store,runner}=await setup(t);
  runner.perform=async()=>({after:null,inputDispatched:null,uncertainDispatch:true,confirmation:{status:'pending',reason:'transport uncertain'},network:[]});
  assert.equal((await request('/api/games/one/mark',{...ref(store.game('one')),requestId:'req-unknown-result',mode:'buy',x:.5,y:.5,execute:true})).status,200);
  assert.equal(store.game('one').actions[0].inputDispatched,null);
  await request('/api/games/one/refresh',{...ref(store.game('one')),requestId:'req-unknown-refresh'});
  await request('/api/games/one/mark',{...ref(store.game('one')),requestId:'req-after-uncertain',mode:'cancel',x:.4,y:.5,execute:false});
  const route=store.export().routes.find(r=>r.kind==='cancel');
  assert.equal(route.replayAllowed,false); assert.equal(route.status,'needs_review');
  const purchase=store.export().routes.find(r=>r.kind==='buy');
  assert.equal(purchase.replayAllowed,false); assert.equal(purchase.status,'needs_review');
});
test('finished captures reject existing control execution while completed duplicates stay readable',async t=>{
  const {request,store,performed}=await setup(t);
  const identity=ref(store.game('one'));
  const marked=await request('/api/games/one/mark',{...identity,requestId:'req-before-finish',mode:'spin',x:.9,y:.8});
  const finished={...identity,requestId:'req-finish-game'};
  assert.equal((await request('/api/games/one/finish',finished)).status,200);
  assert.equal((await request('/api/games/one/finish',finished)).status,200);
  assert.equal((await request('/api/games/one/action',{...identity,requestId:'req-after-finish',controlId:marked.data.control.id})).status,409);
  assert.equal(performed.length,0);
});
test('a failed post-input action write preserves dispatch truth and recovery ancestry',async t=>{
  const {request,store,performed}=await setup(t);
  const updateAction=store.updateAction.bind(store);
  store.updateAction=async()=>{throw new Error('injected storage failure before action update');};
  const result=await request('/api/games/one/mark',{...ref(store.game('one')),requestId:'req-failed-action-write',mode:'buy',x:.5,y:.5,execute:true});
  assert.equal(result.status,503);
  assert.equal(performed.length,1);
  assert.equal(store.game('one').requiresReview,true);
  assert.equal(store.game('one').actions[0].inputDispatched,true);
  store.updateAction=updateAction;
  const action=store.game('one').actions[0];
  assert.equal((await request('/api/games/one/refresh',{...ref(store.game('one')),requestId:'req-storage-recovery'})).status,200);
  assert.equal(store.game('one').screen.route.at(-1),action.controlId);
});
test('a failed uncertain-action write still closes the input gate and preserves uncertainty',async t=>{
  const {request,store,runner}=await setup(t);
  runner.perform=async()=>{throw new Error('transport outcome unknown');};
  store.updateAction=async()=>{throw new Error('injected disk failure');};
  const result=await request('/api/games/one/mark',{...ref(store.game('one')),requestId:'req-uncertain-write-fail',mode:'buy',x:.5,y:.5,execute:true});
  assert.ok(result.status>=400);
  assert.equal(store.game('one').requiresReview,true);
  assert.equal(store.game('one').actions[0].inputDispatched,null);
  assert.equal(store.game('one').actions[0].uncertainDispatch,true);
});
