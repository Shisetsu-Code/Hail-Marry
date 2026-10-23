import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const module = await import('../store.mjs').catch(() => ({}));
const targets = [{ id:'one', title:'Uno', provider:'fixture' }, { id:'two', title:'Dos', provider:'fixture' }];
const observation = (sessionId='session-one', text='image') => {
  const image = Buffer.from(text);
  return {image,imageSha256:createHash('sha256').update(image).digest('hex'),sessionId,width:1000,height:600,at:new Date().toISOString(),candidates:[],state:{phase:'base'}};
};
async function setup(t) {
  assert.equal(typeof module.GuidedStore,'function','GuidedStore must exist');
  const directory = await mkdtemp(path.join(os.tmpdir(),'guided-store-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store = await module.GuidedStore.open({directory,runId:'test-run',targets});
  const screen = await store.capture('one',observation());
  return {store,directory,screen};
}
const ref = screen => ({screenId:screen.id,revision:screen.revision,imageSha256:screen.imageSha256});

test('spin mark and spin-only completion persist without synthesizing an input',async t=>{
  const {store,directory,screen}=await setup(t);
  await store.addControl('one',{...ref(screen),mode:'spin_only',x:.9,y:.8});
  const game=store.game('one');
  assert.equal(game.finished,true); assert.equal(game.controls.length,1);
  assert.equal(game.controls[0].role,'spin'); assert.equal(game.actions.length,0);
  const restored=await module.GuidedStore.open({directory,runId:'test-run',targets});
  assert.equal(restored.game('one').finished,true);
  assert.deepEqual(await readFile(path.join(directory,'images',path.basename(screen.imageUrl))),Buffer.from('image'));
});
test('stale hash or revision and out-of-image points never create controls',async t=>{
  const {store,screen}=await setup(t);
  for(const override of [{revision:screen.revision+1},{imageSha256:'0'.repeat(64)},{x:1.1},{y:-.1}]){
    await assert.rejects(store.addControl('one',{...ref(screen),mode:'menu',x:.3,y:.4,...override}));
  }
  assert.equal(store.game('one').controls.length,0);
});
test('antebet requires the same game normal Spin and exports an ordered composite',async t=>{
  const {store,screen}=await setup(t);
  const second=await store.capture('two',observation('session-two'));
  await store.addControl('two',{...ref(second),mode:'spin',x:.9,y:.8});
  await assert.rejects(store.addControl('one',{...ref(screen),mode:'antebet',x:.5,y:.8}),/Spin/);
  const spin=await store.addControl('one',{...ref(screen),mode:'spin',x:.9,y:.8});
  const ante=await store.addControl('one',{...ref(screen),mode:'antebet',x:.5,y:.8});
  assert.equal(ante.spinControlId,spin.id);
  const route=store.export().routes.find(r=>r.controlId===ante.id);
  assert.deepEqual(route.steps.map(s=>s.controlId),[ante.id,spin.id]);
});
test('multiple menu roots and confirm/cancel branches keep immutable capture ancestry',async t=>{
  const {store,screen}=await setup(t);
  const menuA=await store.addControl('one',{...ref(screen),mode:'menu',x:.2,y:.2});
  const menuB=await store.addControl('one',{...ref(screen),mode:'menu',x:.4,y:.2});
  const child=await store.capture('one',observation('session-one','menu-image'),{parentScreenId:screen.id,viaControlId:menuA.id,route:[menuA.id]});
  const buy=await store.addControl('one',{...ref(child),mode:'buy',x:.5,y:.5});
  const dialog=await store.capture('one',observation('session-one','confirm-image'),{parentScreenId:child.id,viaControlId:buy.id,route:[menuA.id,buy.id]});
  await store.addControl('one',{...ref(dialog),mode:'confirm',x:.6,y:.6});
  await store.addControl('one',{...ref(dialog),mode:'cancel',x:.4,y:.6});
  const graph=store.export();
  assert.equal(graph.routes.filter(r=>r.kind==='menu').length,2);
  assert.ok(graph.routes.some(r=>r.controlId===menuB.id));
  assert.deepEqual(graph.routes.find(r=>r.kind==='confirm').steps.map(s=>s.controlId).slice(0,2),[menuA.id,buy.id]);
  assert.equal(store.game('one').screens.find(s=>s.id===screen.id).imageSha256,screen.imageSha256);
});
test('request ids survive restart, reject changed payloads and never imply successful input',async t=>{
  const {store,directory}=await setup(t);
  const request={requestId:'request-unique-1',mode:'continue',x:.5,y:.5};
  assert.equal((await store.beginRequest('one',request)).duplicate,false);
  assert.equal((await store.beginRequest('one',request)).duplicate,true);
  await assert.rejects(store.beginRequest('one',{...request,x:.7}),/requestId/);
  const restored=await module.GuidedStore.open({directory,runId:'test-run',targets});
  assert.equal((await restored.beginRequest('one',request)).duplicate,true);
  assert.equal(restored.game('one').actions.length,0);
});
test('only-spin cannot silently discard already taught purchase controls',async t=>{
  const {store,screen}=await setup(t);
  await store.addControl('one',{...ref(screen),mode:'buy',x:.2,y:.2});
  await assert.rejects(store.addControl('one',{...ref(screen),mode:'spin_only',x:.9,y:.8}),/Solo Spin/);
  assert.equal(store.game('one').finished,false);
  assert.equal(store.game('one').controls.length,1);
});
test('Q is an explicit continue route and executed dependencies cannot be removed',async t=>{
  const {store,screen}=await setup(t);
  const control=await store.addControl('one',{...ref(screen),mode:'continue',x:.5,y:.8});
  const action=await store.addAction('one',{controlId:control.id,fromScreenId:screen.id,role:'continue',status:'intent',inputDispatched:false});
  await assert.rejects(store.removeControl('one',control.id,ref(screen)),/acción|action|ejecut/);
  assert.equal(store.export().routes.find(r=>r.controlId===control.id).kind,'continue');
  assert.equal(store.game('one').actions.find(a=>a.id===action.id).inputDispatched,false);
});
test('published evidence keeps geometry but removes URL credentials and secret fields',async t=>{
  const {store,directory}=await setup(t);
  const next=observation('session-one','sanitized-image');
  next.state={controls:[{frameUrl:'https://user:private-pass@example.com/game?token=private-token#private-fragment',bounds:{x:10,y:20,width:100,height:50}}],
    authorization:'Bearer private-bearer',headers:{cookie:'private-cookie'},responseBody:'private-body',
    coverage:{errors:['Navigation failed at https://example.com/game?session=private-session']}};
  await store.capture('one',next);
  const stored=await readFile(path.join(directory,'state.json'),'utf8');
  assert.ok(!stored.includes('private-'));
  assert.equal(store.game('one').screen.state.controls[0].frameUrl,'https://example.com/game');
  assert.equal(store.game('one').screen.state.controls[0].bounds.width,100);
});
test('restart turns an interrupted published intent into unknown dispatch and blocks its own route',async t=>{
  const {store,directory,screen}=await setup(t);
  const control=await store.addControl('one',{...ref(screen),mode:'buy',x:.3,y:.4});
  await store.beginRequest('one',{requestId:'interrupted-purchase-request',mode:'buy',x:.3,y:.4});
  await store.setGame('one',{busy:true});
  await store.addAction('one',{controlId:control.id,fromScreenId:screen.id,role:'buy',status:'intent',inputDispatched:false});
  await store.checkpoint();
  const restored=await module.GuidedStore.open({directory,runId:'test-run',targets});
  const action=restored.game('one').actions[0];
  assert.equal(action.inputDispatched,null);
  assert.equal(action.uncertainDispatch,true);
  assert.equal(action.status,'uncertain');
  assert.equal(restored.game('one').requiresReview,true);
  assert.equal(restored.data.requests['interrupted-purchase-request'].status,'failed');
  const fresh=await restored.capture('one',observation('new-browser-session','new-session-image'));
  await restored.setGame('one',{requiresReview:false});
  const oldRoute=restored.export().routes.find(route=>route.controlId===control.id);
  assert.equal(oldRoute.replayAllowed,false);assert.equal(oldRoute.status,'needs_review');
  const current=await restored.addControl('one',{...ref(fresh),mode:'continue',x:.5,y:.5});
  assert.equal(restored.export().routes.find(route=>route.controlId===current.id).replayAllowed,true);
});
test('screenshot coordinate transforms survive capture, reference and route export',async t=>{
  const {store}=await setup(t);
  const next=observation('session-one','scaled-mobile-image');
  next.coordinateTransform={scale:.42040816,offsetLeft:3,offsetTop:7,visualWidth:980,visualHeight:1996,layoutWidth:981,layoutHeight:1996};
  const screen=await store.capture('one',next);
  const control=await store.addControl('one',{...ref(screen),mode:'continue',x:.65,y:.23});
  assert.deepEqual(store.reference(screen).coordinateTransform,next.coordinateTransform);
  assert.deepEqual(store.export().routes.find(route=>route.controlId===control.id).steps[0].coordinateTransform,next.coordinateTransform);
  await assert.rejects(store.capture('one',{...next,coordinateTransform:{...next.coordinateTransform,scale:0}}),/coordenadas|transformación/);
});
