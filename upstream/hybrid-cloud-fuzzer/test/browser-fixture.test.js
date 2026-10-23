import test from 'node:test';
import assert from 'node:assert/strict';
import {executeDemoBranch} from '../local/branch-executor.js';
import {dismissCatalogueOverlays,captureWithoutCatalogueOverlays} from '../local/intro.js';
import {matchReviewedImage} from '../local/visual-match.js';

test('visual replay matches the reviewed screen and rejects a changed button or blank loader',
 {skip:process.env.INTEGRATION_BROWSER!=='1'},async()=>{
 const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:800,height:450}});
  await page.setContent('<style>body{background:#123;color:white;font:32px sans-serif}button{position:absolute;left:300px;top:180px;width:200px;height:80px;font:24px sans-serif;background:#eab;color:#123}</style><h1>Demo reference</h1><button>CONTINUE</button>');
  const reference=await page.screenshot({type:'jpeg'}),point={x:.5,y:.5};
  assert.equal((await matchReviewedImage(page,reference,await page.screenshot({type:'jpeg'}),point)).matched,true);
  await page.locator('button').evaluate(el=>{el.textContent='BUY $200';el.style.background='red';});
  assert.equal((await matchReviewedImage(page,reference,await page.screenshot({type:'jpeg'}),point)).matched,false);
  await page.setContent('<body style="background:black"></body>');const blank=await page.screenshot({type:'jpeg'});
  assert.equal((await matchReviewedImage(page,blank,blank,point)).matched,false);
 }finally{await browser.close();}
});

test('one reviewed buy runs confirmation, bonus start, active rounds and final collection before capture',
 {skip:process.env.INTEGRATION_BROWSER!=='1'},async()=>{
 const {chromium}=await import('playwright');let wagers=0;
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#123;color:white;font:24px sans-serif}button{margin:20px;padding:20px}</style>
 <body><main id="game"></main><script>
 const game=document.querySelector('#game');
 const base=()=>{game.innerHTML='<button id="buy">Buy feature</button><button>Spin</button>';document.querySelector('#buy').onclick=()=>{
 game.innerHTML='<p>Confirm purchase of free spins</p><button id="confirm">Confirm</button><button>Cancel</button>';
 document.querySelector('#confirm').onclick=async()=>{await fetch('/api/bonus',{method:'POST',body:'action=doSpin&bet=2'});
 game.innerHTML='<p>Bonus</p><button id="start">Start free spins</button>';
 document.querySelector('#start').onclick=()=>{game.innerHTML='<p>Free spins remaining: 3</p>';setTimeout(()=>{
 game.innerHTML='<p>Total win 12.50</p><button id="collect">Collect</button>';document.querySelector('#collect').onclick=base;
 },1800);};};};};base();
 </script>`;
 const launcher={launch:async options=>{
  const browser=await chromium.launch(options);
  return {newContext:async opts=>{
   const context=await browser.newContext(opts);
   await context.route('https://www.pragmaticplay.fun/en/slots/alpha/',r=>r.fulfill({contentType:'text/html',body:html}));
   await context.route('https://www.pragmaticplay.fun/api/bonus',r=>{wagers++;return r.fulfill({contentType:'application/json',body:'{"ok":true}'});});
   return context;
  },close:()=>browser.close()};
 }};
 const task={runId:'r',provider:'pragmatic',gameId:'alpha',shotId:'step-complete',parentId:'parent',parentRevision:2,parentSourceSha256:'a'.repeat(64),
  path:[{kind:'buy',label:'Buy feature',state:'BASE',x:.05,y:.07}]};
 const source={provider:'pragmatic',gameId:'alpha',metadata:{url:'https://www.pragmaticplay.fun/en/slots/alpha/'}};
 const result=await executeDemoBranch(task,source,{chromium:launcher,openDemo:async()=>{},waitMs:450,transitionWaitMs:15000,log:()=>{}});
 assert.equal(wagers,1,'no second purchase or normal spin');
 assert.equal(result.info.state,'BASE');assert.equal(result.info.metadata.roundOutcome,'completed');assert.equal(result.info.metadata.terminal,true);
 assert.deepEqual(result.info.metadata.transitions[0].actions.map(a=>a.label),['Confirm','Start free spins','Collect']);
 assert.equal(result.trace.log.entries.filter(e=>e.request.method==='POST').length,1);
});

test('recurring consent is cleared in every fresh Chromium context and after screenshot races',
 {skip:process.env.INTEGRATION_BROWSER!=='1'},async()=>{
 const {chromium}=await import('playwright');
 const browser=await chromium.launch({headless:true});
 const url='https://www.pragmaticplay.fun/en/slots/alpha/';
 const html=`<body><button id="reject">Reject All</button><script>
 window.rejects=0;document.querySelector('button').onclick=()=>{
 window.rejects++;document.querySelector('button').style.display='none';
 if(window.rejects<3)setTimeout(()=>document.querySelector('button').style.display='block',30);
 };</script>`;
 try{
  for(let n=0;n<2;n++){
   const context=await browser.newContext();
   try{
    await context.route(url,r=>r.fulfill({status:200,contentType:'text/html',body:html}));
    const page=await context.newPage();await page.goto(url);
    const result=await dismissCatalogueOverlays(page,{provider:'pragmatic',url,requireClear:true});
    assert.equal(result.cookiesDismissed,3);
    let attempts=0;
    const snapshot=await captureWithoutCatalogueOverlays(page,{provider:'pragmatic',url},async()=>{
     attempts++;if(attempts===1)await page.evaluate(()=>document.querySelector('button').style.display='block');
     const covered=await page.getByRole('button',{name:'Reject All'}).isVisible();
     await page.screenshot({type:'jpeg'});return {covered};
    });
    assert.equal(snapshot.covered,false);assert.equal(attempts,2);
   }finally{await context.close();}
  }
 }finally{await browser.close();}
});

// A local, deterministic demo fixture exercises Chromium, iframe-independent hitboxes,
// action-correlated POST capture, child screenshot, and terminal wager detection.
test('Playwright public demo fixture: classified control -> HTTP request + next screen',
 {skip:process.env.INTEGRATION_BROWSER!=='1'},async()=>{
 const {chromium}=await import('playwright');
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#123}button{position:absolute;left:128px;top:144px;width:128px;height:72px}</style>
 <body data-state="BASE"><button id="buy">BUY FEATURE</button><script>
 document.querySelector('#buy').addEventListener('click',async()=>{const res=await fetch('/api/spin',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'action=doSpin&bet=2'});if(res.ok)document.body.dataset.state='BONUS';});
 </script>`;
 const launcher={async launch(opts){const browser=await chromium.launch(opts);return {
   async newContext(copts){const ctx=await browser.newContext(copts);
    await ctx.route('https://www.pragmaticplay.fun/en/slots/alpha/',r=>r.fulfill({status:200,contentType:'text/html',body:html}));
    await ctx.route('https://www.pragmaticplay.fun/api/spin',r=>r.fulfill({status:200,contentType:'application/json',body:'{"rs":"mc","win":0}'}));return ctx;},
   close:()=>browser.close()};}};
 const task={runId:'r',provider:'pragmatic',gameId:'alpha',shotId:'step-test',parentId:'r:pragmatic:alpha:base',parentSourceSha256:'a'.repeat(64),parentRevision:2,
  path:[{kind:'buy',label:'BUY FEATURE',state:'BASE',x:.15,y:.25,controlPath:'Game/Buy'}]};
 const source={runId:'r',provider:'pragmatic',gameId:'alpha',state:'BASE',metadata:{url:'https://www.pragmaticplay.fun/en/slots/alpha/'}};
 const inspect=async page=>{const state=await page.evaluate(()=>document.body.dataset.state);
  return {frame:page.mainFrame(),data:{state,mode:state==='BASE'?'structured':'visual',adapter:'test-runtime',adapterVersion:'1',candidates:state==='BASE'?[{id:'c1',label:'BUY FEATURE',confidence:.95,path:'Game/Buy',rect:{x:.1,y:.2,w:.1,h:.1}}]:[]}};};
 const result=await executeDemoBranch(task,source,{chromium:launcher,openDemo:async()=>({launched:true}),inspect,frameBox:async()=>({clip:null,aligned:true}),waitMs:650,log:()=>{}});
 assert.equal(result.info.state,'BONUS');assert.equal(result.info.metadata.evidenceStatus,'bet_request_observed');
 assert.equal(result.info.metadata.terminal,false,'a wager request and unknown bonus screen are not a completed round');
 assert.equal(result.info.metadata.roundOutcome,'needs_review');assert.equal(result.image[0],255);assert.equal(result.image[1],216);
 const wager=result.trace.log.entries.find(e=>e.request.method==='POST'&&e.request.url.includes('/api/spin'));
 assert.ok(wager);assert.match(wager.request.postData.text,/doSpin/);
});

test('Delayed catalogue cookie CMP is dismissed before clicking reviewed DEMO buttons',
 {skip:process.env.INTEGRATION_BROWSER!=='1'},async()=>{
 const {chromium}=await import('playwright');
 const html=`<!doctype html><meta charset="utf-8">
 <style>body{margin:0;background:#123}#buy{position:absolute;left:128px;top:144px;width:128px;height:72px}
 #cmp{position:fixed;inset:0;background:#222b;z-index:100;display:none}#reject{position:absolute;left:140px;top:155px;width:160px;height:60px}</style>
 <body data-state="BASE"><button id="buy">BUY FEATURE</button><div id="cmp"><button id="reject">Reject All</button></div>
 <script>
 setTimeout(()=>{document.querySelector('#cmp').style.display='block'},200);
 document.querySelector('#reject').addEventListener('click',()=>{document.querySelector('#cmp').style.display='none'});
 document.querySelector('#buy').addEventListener('click',async()=>{
 const res=await fetch('/api/spin',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'action=doSpin&bet=2'});
 if(res.ok)document.body.dataset.state='BONUS';
 });
 </script>`;
 const launcher={async launch(opts){const browser=await chromium.launch(opts);return {
  async newContext(copts){const ctx=await browser.newContext(copts);
   await ctx.route('https://www.pragmaticplay.fun/en/slots/alpha/',r=>r.fulfill({status:200,contentType:'text/html',body:html}));
   await ctx.route('https://www.pragmaticplay.fun/api/spin',r=>r.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'}));return ctx;},
  close:()=>browser.close()};}};
 const task={runId:'r',provider:'pragmatic',gameId:'alpha',shotId:'step-delayed-cookie',
  parentId:'r:pragmatic:alpha:base',parentSourceSha256:'a'.repeat(64),parentRevision:2,
  path:[{kind:'buy',label:'BUY FEATURE',state:'BASE',x:.15,y:.25,controlPath:'Game/Buy'}]};
 const source={runId:'r',provider:'pragmatic',gameId:'alpha',state:'BASE',
  metadata:{url:'https://www.pragmaticplay.fun/en/slots/alpha/'}};
 const inspect=async page=>{const state=await page.evaluate(()=>document.body.dataset.state);
  return {frame:page.mainFrame(),data:{state,mode:'structured',adapter:'test-runtime',adapterVersion:'1',
   candidates:state==='BASE'?[{id:'c1',label:'BUY FEATURE',confidence:.95,path:'Game/Buy',rect:{x:.1,y:.2,w:.1,h:.1}}]:[]}};};
 const result=await executeDemoBranch(task,source,{chromium:launcher,openDemo:async()=>({launched:true}),
  inspect,frameBox:async()=>({clip:null,aligned:true}),waitMs:650,log:()=>{}});
 assert.equal(result.info.state,'BONUS','CMP must not intercept the buy click');
 assert.equal(result.info.metadata.evidenceStatus,'bet_request_observed');
 assert.equal(result.trace.log.entries.filter(e=>e.request?.method==='POST'&&e.request.url.includes('/api/spin')).length,1);
});
