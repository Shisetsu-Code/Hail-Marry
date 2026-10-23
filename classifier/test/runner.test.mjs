import test from 'node:test';
import assert from 'node:assert/strict';

test('browser runner exports the contract without starting a browser', async () => {
  let module;
  try { module = await import('../runner.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof module?.BrowserRunner, 'function', 'BrowserRunner implementation must be available');
});

import { before, after } from 'node:test';
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
let browser, server, url, temp, BrowserRunner;
before(async () => {
  ({ BrowserRunner } = await import('../runner.mjs'));
  const html = await readFile(new URL('../fixtures/game.html', import.meta.url));
  server = http.createServer((request, response) => response.end(request.url === '/framed.html' ? '<iframe src="/game.html" style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe><div id="cover" style="display:none;position:absolute;z-index:2;width:20px;height:20px;background:rgba(0,0,0,.01)"></div>' : html));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/game.html`;
  temp = await mkdtemp(join(tmpdir(), 'guided-runner-'));
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || chromium.executablePath(), headless:true, args:['--no-sandbox']});
});
after(async () => { await browser?.close(); if(server) await new Promise(resolve=>server.close(resolve)); if(temp) await rm(temp,{recursive:true,force:true}); });
async function setup(t, ids=['a'], targetUrl=url) {
  const runner = new BrowserRunner({browser, targets:ids.map(id=>({id,url:targetUrl})), initialWaitMs:5,settleMs:20,localFixture:true});
  t.after(()=>runner.close());
  const observation=await runner.open(ids[0]);
  const page=browser.contexts().at(-1).pages()[0];
  return {runner,observation,page};
}
async function reference(observation) {
  const imagePath=join(temp,`${observation.sessionId}-${observation.imageSha256}.jpg`);
  await writeFile(imagePath,observation.image);
  return {imagePath,sessionId:observation.sessionId,width:observation.width,height:observation.height,imageSha256:observation.imageSha256,coordinateTransform:observation.coordinateTransform};
}
function control(observation,label,mode='continue',gameId='a') {
  const candidate=observation.candidates.find(c=>c.label===label);
  assert.ok(candidate,`fixture candidate ${label}`);
  return {id:`control-${label}`,gameId,screenId:'screen',sessionId:observation.sessionId,mode,role:mode,label,x:candidate.x,y:candidate.y};
}
async function perform(runner, observation,label,mode='continue',extra={}) {
  return runner.perform('a',{control:control(observation,label,mode),reference:await reference(observation),...extra});
}

test('Q continuation dispatches once and captures the next screen as pending evidence',async t=>{
  const {runner,observation,page}=await setup(t);
  assert.ok(Buffer.isBuffer(observation.image));
  assert.equal(observation.imageSha256,createHash('sha256').update(observation.image).digest('hex'));
  assert.equal(observation.width,1280); assert.equal(observation.height,720);
  const result=await perform(runner,observation,'Continuar');
  assert.equal(result.inputDispatched,true);assert.equal(result.confirmation.status,'pending');
  assert.notEqual(result.before.imageSha256,result.after.imageSha256);
  assert.equal(await page.evaluate(()=>screenName),'base');
  assert.deepEqual(await page.evaluate(()=>inputs),['continue']);
});

test('a transport error after the actual click preserves uncertain dispatch and invalidates the reference',async t=>{
  const {runner,observation,page}=await setup(t);
  const click=page.mouse.click.bind(page.mouse);
  page.mouse.click=async(...args)=>{await click(...args);throw new Error('Click transport response lost');};
  const result=await perform(runner,observation,'Continuar');
  assert.deepEqual(await page.evaluate(()=>inputs),['continue']);
  assert.equal(result.inputDispatched,null);assert.equal(result.uncertainDispatch,true);
  assert.equal(result.after,null);assert.equal(result.confirmation.status,'pending');
  page.mouse.click=click;
  await assert.rejects(perform(runner,observation,'Continuar'),error=>error.inputMayHaveDispatched===false&&/stale/i.test(error.message));
});

test('unchanged pixels never promote dispatched input to a confirmed effect',async t=>{
  const {runner,observation,page}=await setup(t);
  await page.evaluate(()=>document.querySelector('#continue').onclick=()=>inputs.push('continue'));
  const result=await perform(runner,observation,'Continuar');
  assert.equal(result.inputDispatched,true);assert.equal(result.confirmation.status,'pending');
  assert.equal(result.before.imageSha256,result.after.imageSha256);
  assert.deepEqual(await page.evaluate(()=>inputs),['continue']);
});

test('stale scene, wrong session, wrong game, viewport and tampered reference reject before input',async t=>{
  const {runner,observation,page}=await setup(t);
  const ref=await reference(observation),mark=control(observation,'Continuar');
  await assert.rejects(runner.perform('a',{control:mark,reference:{...ref,sessionId:'other'}}),/session/i);
  await assert.rejects(runner.perform('a',{control:{...mark,gameId:'b'},reference:ref}),/game/i);
  await assert.rejects(runner.perform('a',{control:mark,reference:{...ref,width:900}}),/viewport/i);
  await assert.rejects(runner.perform('a',{control:mark,reference:{...ref,imageSha256:'0'.repeat(64)}}),/hash/i);
  await writeFile(ref.imagePath,Buffer.from('not a jpeg'));
  await assert.rejects(runner.perform('a',{control:mark,reference:ref}),/hash|JPEG|reference/i);
  await reference(observation);await page.evaluate(()=>render('base'));
  await assert.rejects(runner.perform('a',{control:mark,reference:ref}),/changed|stale/i);
  assert.deepEqual(await page.evaluate(()=>inputs),[]);
});

test('a visually subtle cover still rejects the marked DOM control',async t=>{
  const {runner,observation,page}=await setup(t);
  await page.evaluate(()=>document.querySelector('#cover').style.display='block');
  await assert.rejects(perform(runner,observation,'Continuar'),/covered|occluded|unavailable|hit/i);
  assert.deepEqual(await page.evaluate(()=>inputs),[]);
});

test('disabled DOM control rejects before dispatch',async t=>{
  const {runner,observation,page}=await setup(t);
  await page.evaluate(()=>document.querySelector('#continue').disabled=true);
  await assert.rejects(perform(runner,observation,'Continuar'),/disabled|unavailable/i);
  assert.deepEqual(await page.evaluate(()=>inputs),[]);
});

test('an exact-point parent-frame cover rejects even when other button points are hittable',async t=>{
  const {runner,observation,page}=await setup(t,['a'],new URL('/framed.html',url).href);
  const mark=control(observation,'Continuar');
  await page.evaluate(({x,y})=>{const cover=document.querySelector('#cover');cover.style.left=(x*1280-10)+'px';cover.style.top=(y*720-10)+'px';cover.style.display='block';},mark);
  await assert.rejects(runner.perform('a',{control:mark,reference:await reference(observation)}),/covered|occluded|unavailable|hit/i);
  assert.deepEqual(await page.frames()[1].evaluate(()=>inputs),[]);
});

test('nested menu, option and cancel require individual reviewed actions',async t=>{
  const {runner,observation,page}=await setup(t);
  let result=await perform(runner,observation,'Continuar');
  result=await perform(runner,result.after,'Comprar','menu');assert.equal(await page.evaluate(()=>screenName),'menu');
  result=await perform(runner,result.after,'Más opciones','menu');assert.equal(await page.evaluate(()=>screenName),'nested');
  result=await perform(runner,result.after,'Opción anidada','option');assert.equal(await page.evaluate(()=>screenName),'confirm');
  result=await perform(runner,result.after,'Cancelar','cancel');assert.equal(await page.evaluate(()=>screenName),'base');
  assert.deepEqual(await page.evaluate(()=>inputs),['continue','menu','nested','option','cancel']);
  assert.equal(result.confirmation.status,'pending');
});

test('direct purchase and confirmation remain two explicit actions',async t=>{
  const {runner,observation,page}=await setup(t);
  let r=await perform(runner,observation,'Continuar');r=await perform(runner,r.after,'Otra compra','buy');
  r=await perform(runner,r.after,'Compra directa','buy');assert.equal(await page.evaluate(()=>screenName),'confirm');
  r=await perform(runner,r.after,'Confirmar','confirm');assert.equal(await page.evaluate(()=>screenName),'purchased');
  assert.equal(r.confirmation.status,'pending');assert.deepEqual(await page.evaluate(()=>inputs),['continue','menu2','option','confirm']);
});

test('spin_only performs no input; unsupported scopes never bypass full scene verification',async t=>{
  const {runner,observation,page}=await setup(t);
  await assert.rejects(perform(runner,observation,'Continuar','spin_only'),/mark|input|spin_only/i);
  await assert.rejects(perform(runner,observation,'Continuar','continue',{scope:'target'}),/scope|linked|spin/i);
  await assert.rejects(perform(runner,observation,'Continuar','continue',{scope:'anything'}),/scope/i);
  assert.deepEqual(await page.evaluate(()=>inputs),[]);
});

test('ante changes scene; only explicitly linked Spin can use target matching',async t=>{
  const {runner,observation,page}=await setup(t);
  let r=await perform(runner,observation,'Continuar');const base=r.after;
  const spin=control(base,'Girar','spin'),ref=await reference(base),ante=control(base,'Antebet','antebet');
  r=await runner.perform('a',{control:ante,reference:ref});
  assert.deepEqual(await page.evaluate(()=>inputs),['continue','ante']);
  await assert.rejects(runner.perform('a',{control:spin,reference:ref}),/changed|stale/i);
  await assert.rejects(runner.perform('a',{control:spin,reference:ref,scope:'target'}),/linked/i);
  r=await runner.perform('a',{control:{...spin,linkedAnteControlId:ante.id},reference:ref,scope:'target'});
  assert.deepEqual(await page.evaluate(()=>inputs),['continue','ante','spin']);assert.equal(r.confirmation.status,'pending');
});

test('linked spin cannot click through an ante purchase overlay',async t=>{
  const {runner,observation,page}=await setup(t);let r=await perform(runner,observation,'Continuar');const base=r.after;
  const ante=control(base,'Antebet','antebet');await perform(runner,base,'Antebet','antebet');
  await page.evaluate(()=>document.querySelector('#cover').style.display='block');
  await assert.rejects(runner.perform('a',{control:{...control(base,'Girar','spin'),linkedAnteControlId:ante.id},reference:await reference(base),scope:'target'}),/covered|occluded|unavailable|hit/i);
  assert.deepEqual(await page.evaluate(()=>inputs),['continue','ante']);
});

test('a linked Spin marked before refresh is revalidated after ante from a newer image',async t=>{
  const {runner,observation,page}=await setup(t);const base=(await perform(runner,observation,'Continuar')).after;
  const spin=control(base,'Girar','spin'),spinReference=await reference(base);
  await page.evaluate(()=>document.querySelector('#title').textContent='Base refreshed view');
  const refreshed=await runner.observe('a');assert.notEqual(refreshed.imageSha256,base.imageSha256);
  const ante=control(refreshed,'Antebet','antebet');
  await runner.perform('a',{control:ante,reference:await reference(refreshed)});
  const result=await runner.perform('a',{control:{...spin,linkedAnteControlId:ante.id},reference:spinReference,scope:'target'});
  assert.equal(result.inputDispatched,true);assert.deepEqual(await page.evaluate(()=>inputs),['continue','ante','spin']);
});

test('two games keep separate sessions and reject cross-game references',async t=>{
  const {runner,observation,page}=await setup(t,['a','b']);const second=await runner.open('b');
  assert.notEqual(second.sessionId,observation.sessionId);
  await assert.rejects(runner.perform('b',{control:control(second,'Continuar','continue','b'),reference:await reference(observation)}),/session/i);
  await perform(runner,observation,'Continuar');
  const pageB=browser.contexts().at(-1).pages()[0];
  assert.equal(await page.evaluate(()=>screenName),'base');assert.equal(await pageB.evaluate(()=>screenName),'intro');
});

test('unauthorized targets never open and localhost requires fixture mode',async()=>{
  const runner=new BrowserRunner({browser,targets:[{id:'real',url:'https://example.com/?demo=true'},{id:'local',url}],initialWaitMs:60000});
  try {await assert.rejects(runner.open('real'),/demo/i);await assert.rejects(runner.open('local'),/demo/i);await assert.rejects(runner.open('missing'),/target|game/i);}finally{await runner.close()}
});

test('provider device profile sets the observation viewport and touch context',async t=>{
  const runner=new BrowserRunner({browser,targets:[{id:'phone',url,device:'Pixel 7'}],initialWaitMs:5,settleMs:20,localFixture:true});
  t.after(()=>runner.close());
  const observation=await runner.open('phone');
  assert.equal(observation.width,412);assert.equal(observation.height,839);
  const page=browser.contexts().at(-1).pages()[0];
  assert.equal(await page.evaluate(()=>navigator.maxTouchPoints),1);
  assert.equal(await page.evaluate(()=>devicePixelRatio),2.625);
});

test('no-meta Pixel 7 manual screenshot coordinates reach Continue and candidates match its image position',async t=>{
  const runner=new BrowserRunner({browser,targets:[{id:'phone',url,device:'Pixel 7'}],initialWaitMs:5,settleMs:20,localFixture:true});
  t.after(()=>runner.close());
  const observation=await runner.open('phone'),page=browser.contexts().at(-1).pages()[0];
  assert.equal(await page.locator('meta[name="viewport"]').count(),0);
  assert.equal(observation.width,412);assert.equal(observation.state.viewport.width,981);
  // Hand-checked screenshot position: CSS center (640,467.5), visual scale .42040816.
  const point={x:.65306122,y:.23425604};
  const result=await runner.perform('phone',{control:{id:'manual-phone-continue',gameId:'phone',screenId:'phone-screen',sessionId:observation.sessionId,mode:'continue',role:'continue',label:'Continuar',...point},reference:await reference(observation)});
  assert.deepEqual(await page.evaluate(()=>inputs),['continue'],'the reviewed screenshot point reaches the real control');
  assert.equal(await page.evaluate(()=>screenName),'base');
  assert.equal(result.verification.dom.status,'matched');
  const candidate=observation.candidates.find(candidate=>candidate.label==='Continuar');assert.ok(candidate);
  assert.ok(Math.abs(candidate.x-point.x)<.002&&Math.abs(candidate.y-point.y)<.002);
  assert.ok(observation.coordinateTransform.scale>0&&observation.coordinateTransform.scale<1);
});

test('supplied invalid or mismatched coordinate transforms reject before input',async t=>{
  const {runner,observation,page}=await setup(t),ref=await reference(observation),mark=control(observation,'Continuar');
  for(const coordinateTransform of [null,{}, {...observation.coordinateTransform,scale:0},{...observation.coordinateTransform,scale:NaN},{...observation.coordinateTransform,scale:Infinity},{...observation.coordinateTransform,scale:2},{...observation.coordinateTransform,offsetLeft:-1}]){
    await assert.rejects(runner.perform('a',{control:mark,reference:{...ref,coordinateTransform}}),error=>error.inputMayHaveDispatched===false&&/transform/i.test(error.message));
  }
  assert.deepEqual(await page.evaluate(()=>inputs),[]);
});

test('actual visual viewport drift before fresh capture rejects without input',async t=>{
  const {runner,observation,page}=await setup(t);
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1.25});
  await assert.rejects(perform(runner,observation,'Continuar'),error=>error.inputMayHaveDispatched===false&&/transform/i.test(error.message));
  assert.deepEqual(await page.evaluate(()=>inputs),[]);
  await cdp.detach();
});

test('visual viewport drift after image comparison still rejects immediately before dispatch',async t=>{
  const {runner,observation,page}=await setup(t),cdp=await page.context().newCDPSession(page);
  const evaluate=page.evaluate.bind(page);let changed=false;
  page.evaluate=async(fn,arg)=>{const result=await evaluate(fn,arg);if(!changed&&arg?.before&&arg?.after&&arg?.point){changed=true;await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1.25});}return result;};
  await assert.rejects(perform(runner,observation,'Continuar'),error=>error.inputMayHaveDispatched===false&&/transform/i.test(error.message));
  assert.equal(changed,true,'real browser scale changed after the image comparison');
  assert.deepEqual(await evaluate(()=>inputs),[]);
  page.evaluate=evaluate;await cdp.detach();
});

test('an identical JPEG cannot replace the supplied reference coordinate transform',async t=>{
  const {runner,page}=await setup(t);
  await page.setContent('<style>body{margin:0;background:#173151;overflow:hidden}</style><script>window.inputs=[];document.addEventListener("click",()=>inputs.push("click"));</script>');
  const original=await runner.observe('a'),ref=await reference(original);
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1.25});
  const newer=await runner.observe('a');
  assert.equal(newer.imageSha256,original.imageSha256,'uniform pixels are byte-identical across distinct coordinate transforms');
  assert.notEqual(newer.coordinateTransform.scale,original.coordinateTransform.scale);
  await assert.rejects(runner.perform('a',{control:{id:'same-jpeg-control',gameId:'a',sessionId:original.sessionId,mode:'continue',x:.5,y:.5},reference:ref}),error=>error.inputMayHaveDispatched===false&&/transform/i.test(error.message));
  assert.deepEqual(await page.evaluate(()=>inputs),[]);await cdp.detach();
});
