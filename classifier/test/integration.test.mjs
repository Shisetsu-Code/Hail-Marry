import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { BrowserRunner } from '../runner.mjs';
import { GuidedStore } from '../store.mjs';
import { createClassifierServer } from '../server.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function listen(server) {
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  if (!server?.listening) return;
  const done = new Promise(resolve=>server.close(resolve));
  server.closeAllConnections();
  await done;
}

test('real UI, authenticated server, persistent store and Chromium runner preserve guided routes end to end', { timeout:120000 }, async t => {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  await access(executablePath); // A missing browser is a failure, not a skipped integration gate.
  const directory = await mkdtemp(path.join(os.tmpdir(),'guided-real-integration-'));
  let browser, fixtureServer, server, runner, uiContext;
  t.after(async()=>{
    const errors=[];
    for(const cleanup of [()=>uiContext?.close(),()=>closeServer(server),()=>runner?.close(),()=>browser?.close(),()=>closeServer(fixtureServer),()=>rm(directory,{recursive:true,force:true})]) {
      try {await cleanup();} catch(error) {errors.push(error);}
    }
    if(errors.length) throw new AggregateError(errors,'Integration cleanup failed');
  });
  browser = await chromium.launch({ executablePath, headless:true, args:['--no-sandbox'] });
  const fixture = await readFile(new URL('../fixtures/game.html',import.meta.url));
  fixtureServer = http.createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(fixture);});
  const fixtureBase = await listen(fixtureServer);
  const targets = [
    {id:'ante-game',title:'Antebet y Spin real',provider:'fixture'},
    {id:'only-game',title:'Solo Spin sin entrada',provider:'fixture'},
    {id:'menu-game',title:'Rutas de compras',provider:'fixture'},
  ].map(target=>({...target,url:`${fixtureBase}/game.html?game=${target.id}`}));
  const store = await GuidedStore.open({directory,runId:'guided-real-integration',targets});
  runner = new BrowserRunner({browser,targets,initialWaitMs:0,settleMs:25,localFixture:true});
  await Promise.all(targets.map(async target=>store.capture(target.id,await runner.open(target.id))));
  const gamePage = id => browser.contexts().flatMap(context=>context.pages()).find(page=>new URL(page.url()).searchParams.get('game')===id);
  const inputLog = id => gamePage(id).evaluate(()=>[...window.inputs]);
  const key = randomBytes(32).toString('base64url');
  server = createClassifierServer({store,runner,tokenHash:sha256(key),publicDir:path.join(projectRoot,'classifier/public')});
  let base = await listen(server);
  const api = async (route,{body,method=body?'POST':'GET',authorized=true}={})=>{
    const response = await fetch(base+route,{method,headers:{...(authorized?{Authorization:`Bearer ${key}`} : {}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const type=response.headers.get('content-type')||'';
    return {status:response.status,body:type.includes('json')?await response.json():await response.arrayBuffer()};
  };
  assert.equal((await api('/api/state',{authorized:false})).status,401);
  assert.equal((await api('/api/export',{authorized:false})).status,401);
  assert.equal((await api(store.game('ante-game').screen.imageUrl,{authorized:false})).status,401);
  assert.equal((await api('/api/state')).status,200);
  assert.equal((await api(store.game('ante-game').screen.imageUrl)).status,200);

  uiContext = await browser.newContext({viewport:{width:1600,height:1050},acceptDownloads:true});
  const page = await uiContext.newPage();
  const uiErrors=[];
  page.on('pageerror',error=>uiErrors.push(error.message));
  await page.goto(base);
  await page.locator('#auth-panel').waitFor({state:'visible'});
  await page.locator('#access-key').fill('invalid-integration-key');
  await page.locator('#auth-form button').click();
  await page.waitForFunction(()=>document.querySelector('#auth-error').textContent.includes('no es válida'));
  await page.locator('#access-key').fill(key);
  await page.locator('#auth-form button').click();
  await ready();
  assert.match(await page.locator('#screenshot').getAttribute('src'),/^blob:/);
  await page.evaluate(()=>sessionStorage.clear());
  await page.goto('about:blank');
  await page.goto(`${base}/#key=${key}`);
  await ready();
  assert.ok(new URL(page.url()).hash.length===0,'the access-key fragment is removed');
  assert.ok(await page.evaluate(key=>sessionStorage.getItem('guidedClassifierKey')===key,key));

  async function ready() {
    await page.locator('#image-wrap').waitFor({state:'visible'});
    await page.locator('#refresh:not(:disabled)').waitFor();
  }
  async function selectGame(id) {
    await page.locator(`[data-game-id="${id}"]`).click();
    await ready();
    assert.equal(await page.locator('[data-game-id].active').getAttribute('data-game-id'),id);
  }
  async function mark(id,label,mode,keybinding) {
    const current=store.game(id), candidate=current.screen.candidates.find(item=>item.label===label);
    assert.ok(candidate,`actual fixture candidate available: ${label}`);
    await ready();
    if(keybinding) await page.keyboard.press(keybinding);
    else await page.locator(`[data-mode="${mode}"]`).click();
    assert.equal(await page.locator(`[data-mode="${mode}"]`).getAttribute('aria-pressed'),'true');
    await page.locator('#mark-label').fill(label);
    await page.locator('#mark-label').blur();
    const image=await page.locator('#screenshot').boundingBox();
    assert.ok(image?.width&&image?.height,'the actual authenticated screenshot is rendered');
    const responsePromise=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/games/${id}/mark`);
    await page.mouse.click(image.x+image.width*candidate.x,image.y+image.height*candidate.y);
    const response=await responsePromise, body=await response.json();
    assert.equal(response.status(),200,body.error||'mark accepted');
    const request=response.request().postDataJSON();
    assert.equal(request.screenId,current.screen.id);assert.equal(request.revision,current.screen.revision);assert.equal(request.imageSha256,current.screen.imageSha256);
    if(mode!=='spin_only') await ready();
    return {request,body};
  }

  const q = await mark('ante-game','Continuar','continue','q');
  assert.deepEqual(await inputLog('ante-game'),['continue']);
  assert.equal(await gamePage('ante-game').evaluate(()=>screenName),'base');
  assert.equal((await api('/api/games/ante-game/mark',{body:q.request})).body.duplicate,true);
  assert.deepEqual(await inputLog('ante-game'),['continue'],'duplicate Q does not dispatch twice');
  const spin = await mark('ante-game','Girar','spin','1');
  assert.equal(spin.request.execute,false);
  assert.deepEqual(await inputLog('ante-game'),['continue'],'mode 1 stores Spin without input');
  const savedSpin=store.game('ante-game').spinControlId;
  await gamePage('ante-game').evaluate(()=>document.querySelector('#title').textContent='Base refreshed by integration fixture');
  const refreshResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/games/ante-game/refresh');
  await page.locator('#refresh').click();assert.equal((await refreshResponse).status(),200);await ready();
  assert.notEqual(store.game('ante-game').screen.imageSha256,spin.request.imageSha256);
  const ante=await mark('ante-game','Antebet','antebet','2');
  assert.deepEqual(await inputLog('ante-game'),['continue','ante','spin']);
  assert.equal(await gamePage('ante-game').evaluate(()=>screenName),'result');
  assert.equal(ante.body.spinAction.inputDispatched,true);
  const anteGame=store.game('ante-game');
  assert.deepEqual(anteGame.actions.map(action=>action.role),['continue','antebet','spin']);
  assert.equal(anteGame.actions.at(-1).controlId,savedSpin);
  assert.equal(anteGame.actions.at(-1).linkedAnteControlId,ante.body.control.id);
  assert.deepEqual(anteGame.screen.route,[q.body.control.id,ante.body.control.id,savedSpin]);
  assert.equal((await api('/api/games/ante-game/mark',{body:ante.request})).body.duplicate,true);
  assert.deepEqual(await inputLog('ante-game'),['continue','ante','spin'],'duplicate composite never repeats ante or Spin');

  await selectGame('only-game');
  await mark('only-game','Continuar','continue','q');
  const beforeOnly=await inputLog('only-game');
  const only=await mark('only-game','Girar','spin_only','5');
  assert.equal(only.request.execute,false);assert.equal(store.game('only-game').finished,true);
  assert.deepEqual(await inputLog('only-game'),beforeOnly,'mode 5 finishes without sending Spin');
  assert.equal(store.game('only-game').actions.length,1);
  assert.equal((await api('/api/games/only-game/mark',{body:only.request})).body.duplicate,true);
  assert.equal(store.game('only-game').controls.length,2);

  await selectGame('menu-game');
  await mark('menu-game','Continuar','continue','q');
  await mark('menu-game','Comprar','menu','3');
  await mark('menu-game','Más opciones','menu','3');
  await mark('menu-game','Volver','back');
  await mark('menu-game','Más opciones','menu','3');
  await mark('menu-game','Opción anidada','option');
  await mark('menu-game','Cancelar','cancel');
  assert.equal(await gamePage('menu-game').evaluate(()=>screenName),'base');
  await mark('menu-game','Otra compra','menu','3');
  await mark('menu-game','Compra directa','buy','4');
  assert.equal(await gamePage('menu-game').evaluate(()=>screenName),'confirm');
  const confirmation=await mark('menu-game','Confirmar','confirm');
  assert.equal(await gamePage('menu-game').evaluate(()=>screenName),'purchased');
  assert.deepEqual(await inputLog('menu-game'),['continue','menu','nested','back','nested','option','cancel','menu2','option','confirm']);
  const menus=store.game('menu-game');
  assert.deepEqual(menus.controls.map(control=>control.mode),['continue','menu','menu','back','menu','option','cancel','menu','buy','confirm']);
  assert.equal(new Set(menus.controls.filter(control=>control.mode==='menu').map(control=>control.screenId)).size,4);
  assert.equal(menus.finished,false,'changed pixels after confirmation do not automatically finish capture');
  for(const game of store.state().games) for(const action of game.actions) {
    assert.equal(action.status,'dispatched');assert.equal(action.inputDispatched,true);
    assert.equal(action.confirmation.status,'pending','the complete stack never fabricates business confirmation');
    const source=game.screens.find(screen=>screen.id===action.fromScreenId),target=game.screens.find(screen=>screen.id===action.toScreenId);
    assert.ok(source&&target);assert.equal(target.parentScreenId,source.id);assert.equal(target.viaControlId,action.controlId);
    assert.deepEqual(target.route,[...source.route,action.controlId]);
  }
  assert.match(await page.locator('#actions').innerText(),/Pendiente de revisar/);
  assert.ok(await page.locator('#history option').count()>3);
  await page.locator('#history').selectOption(confirmation.body.control.screenId);
  await page.locator('#image-wrap').waitFor({state:'visible'});
  assert.equal(await page.locator('#finish').isDisabled(),true,'historical screens remain inspection-only');
  await mkdir(path.join(projectRoot,'artifacts/guided-work'),{recursive:true});
  await page.screenshot({path:path.join(projectRoot,'artifacts/guided-work/integration-ui.png'),fullPage:true});

  const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();
  const download=await downloadPromise;
  const downloaded=JSON.parse(await readFile(await download.path(),'utf8'));
  const exported=(await api('/api/export')).body;
  assert.deepEqual(downloaded.routes,exported.routes);
  assert.equal(exported.routes.length,15);
  const confirmRoute=exported.routes.find(route=>route.controlId===confirmation.body.control.id);
  assert.deepEqual(confirmRoute.steps.map(step=>step.role),['continue','menu','menu','back','menu','option','cancel','menu','buy','confirm']);
  const anteRoute=exported.routes.find(route=>route.controlId===ante.body.control.id);
  assert.deepEqual(anteRoute.steps.map(step=>step.role),['continue','antebet','spin']);
  assert.ok(exported.routes.every(route=>route.steps.every(step=>step.requiresFreshValidation)));
  assert.deepEqual(uiErrors,[]);
  const secretFree=await readFile(path.join(directory,'state.json'),'utf8');
  assert.ok(!secretFree.includes(key),'the random bearer key is absent from saved state');

  // Simulate a browser-process restart: saved graph reloads, but no runner sessions open or inputs replay.
  await page.goto('about:blank');
  await closeServer(server);await runner.close();
  const reloaded=await GuidedStore.open({directory,runId:'guided-real-integration',targets});
  assert.deepEqual(reloaded.export().routes,exported.routes);
  assert.deepEqual(reloaded.state().games,exported.games);
  runner=new BrowserRunner({browser,targets,initialWaitMs:0,settleMs:25,localFixture:true});
  server=createClassifierServer({store:reloaded,runner,tokenHash:sha256(key),publicDir:path.join(projectRoot,'classifier/public')});
  base=await listen(server);
  const contexts=browser.contexts().length;
  const duplicate=await api('/api/games/ante-game/mark',{body:ante.request});
  assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicate,true);
  assert.equal(browser.contexts().length,contexts,'a persisted duplicate does not initialize or replay a browser session');
  assert.deepEqual(reloaded.export().routes,exported.routes);
});
