import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {scrub,sanitizeUrl,sanitizePayload,validateHarMode,shouldSaveHar,createNetworkRecorder,summarizeHar} from '../local/har.js';
import {speedInit,validateSpeed,installSpeed,speedUpGame} from '../local/speed.js';
import {compact} from '../src/mcp.js';

test('sanitized HAR redacts authorization, session, cookies, URLs and sensitive JSON',()=>{
  const url=sanitizeUrl('https://demo.example/api/spin?action=doSpin&pur=1&token=supersecrettoken&sessionId=abc123&extra=deadbeefdeadbeefdeadbeefdeadbeef');
  assert.match(url,/action=doSpin/);assert.match(url,/pur=1/);
  assert.ok(!url.includes('supersecrettoken')&&!url.includes('abc123')&&!url.includes('deadbeefdeadbeef'));
  const body=sanitizePayload(JSON.stringify({action:'doSpin',pur:1,authToken:'xyzsecret',nested:{session:'dontlog',counter:4}}),'application/json');
  assert.equal(JSON.parse(body).action,'doSpin');assert.equal(JSON.parse(body).nested.counter,4);
  assert.ok(!body.includes('xyzsecret')&&!body.includes('dontlog'));
  assert.equal(scrub({email:'user@example.com',balance:42}).email,'[REDACTED]');
  assert.equal(sanitizePayload('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'),'[OPAQUE_OR_SENSITIVE_BODY]');
});

test('HAR mode defaults and opt-in selection are explicit',()=>{
  assert.equal(validateHarMode('fallback'),'fallback');assert.throws(()=>validateHarMode('unsafe'));
  assert.equal(shouldSaveHar('fallback','structured','BASE'),false);
  assert.equal(shouldSaveHar('fallback','visual','INTRO'),true);
  assert.equal(shouldSaveHar('fallback','hybrid','BASE'),true);
  assert.equal(shouldSaveHar('all','structured','BASE'),true);
  assert.equal(shouldSaveHar('off','visual','INTRO'),false);
});

test('HAR recorder captures sanitized request/response and websocket diagnostics with bounded limits',async()=>{
  const context=new EventEmitter();context.pages=()=>[];
  const recorder=createNetworkRecorder(context,{maxEntries:2,maxFrames:2});
  const page=new EventEmitter();context.emit('page',page);
  const socket=new EventEmitter();socket.url=()=> 'wss://example.org/ws?token=secret&room=1';page.emit('websocket',socket);
  socket.emit('framesent',{payload:'{"action":"buy","token":"private","ind":2}'});
  socket.emit('framereceived',{payload:Buffer.from([1,2])});
  socket.emit('framereceived',{payload:'hello'});
  const req={url:()=> 'https://example.org/game/spin?action=doSpin&token=secret',method:()=> 'POST',headers:()=>({'content-type':'application/json','authorization':'Bearer dontlog'}),postData:()=>'{"action":"doSpin","pur":1,"cookie":"secret"}'};
  context.emit('request',req);
  context.emit('response',{request:()=>req,headers:()=>({'content-type':'application/json','set-cookie':'a=b'}),status:()=>200,statusText:()=> 'OK',body:async()=>Buffer.from('{"rs":"mc","token":"server-secret","win":12}')});
  const result=await recorder.finish();const output=JSON.stringify(result.har);
  assert.equal(result.summary.requests,1);assert.equal(result.summary.webSocketFrames,2);
  assert.ok(result.summary.actions.some(x=>x.name==='doSpin'));
  for(const sensitive of ['dontlog','server-secret','"secret"','a=b'])assert.ok(!output.includes(sensitive),sensitive);
  assert.match(output,/doSpin/);assert.equal(JSON.parse(result.har.log.entries[0].response.content.text).win,12);
  assert.equal(result.har.log._truncated,true);
});

test('speed scaling is opt-in, bounded, reconfigurable, and never changes Date.now',async()=>{
  assert.equal(validateSpeed('4'),4);assert.throws(()=>validateSpeed(0));assert.throws(()=>validateSpeed(9));
  const callbacks=[],scheduled=[],clock={t:100};
  const sandbox={setTimeout:(cb,delay)=>{scheduled.push(['timeout',delay]);return 1;},setInterval:(cb,delay)=>{scheduled.push(['interval',delay]);return 2;},
    requestAnimationFrame:cb=>{callbacks.push(cb);return 3;},performance:{now:()=>clock.t},Date:{now:()=>123456}};
  sandbox.globalThis=sandbox;
  const fn=vm.runInNewContext('('+speedInit.toString()+')',sandbox);
  const result=fn(4);assert.equal(result.installed,true);assert.equal(result.virtualClock,true);
  sandbox.setTimeout(()=>{},400);sandbox.setInterval(()=>{},800);
  assert.deepEqual(scheduled,[['timeout',100],['interval',200]]);
  let ts=0;sandbox.requestAnimationFrame(t=>ts=t);callbacks[0](150);assert.equal(ts,300);
  clock.t=150;assert.equal(sandbox.performance.now(),300);
  assert.equal(sandbox.Date.now(),123456);
  fn(8);sandbox.setTimeout(()=>{},400);assert.equal(scheduled.at(-1)[1],50);
  assert.equal(fn(1).updated,true);
});

test('speed helper applies only to chosen frame and does not fail collector on unsupported frames',async()=>{
  let calls=0;const frame={evaluate:async(fn,factor)=>{calls++;return {installed:true,factor}}};
  assert.equal((await installSpeed(frame,4)).factor,4);
  assert.equal((await speedUpGame({},frame,4)).installed,true);
  assert.equal(calls,2);
  assert.equal((await speedUpGame({},frame,1)).factor,1);
  assert.equal((await speedUpGame({}, {evaluate:async()=>{throw Error('navigation')}},4)).installed,false);
});

test('MCP exposes sanitized HAR endpoint/action summary but not local diagnostic file or raw HAR',()=>{
  const item={id:'r:p:g:base',mode:'visual',candidates:[],metadata:{url:'https://example.org/demo',networkDiagnostics:{file:'diagnostics/secret.har',format:'sanitized-har-1.2',summary:{requests:2,actions:[{name:'doSpin',count:1}]}}}};
  const result=compact(item);
  assert.equal(result.metadata.networkDiagnostics.summary.actions[0].name,'doSpin');
  assert.equal(result.metadata.networkDiagnostics.file,undefined);
  assert.ok(!JSON.stringify(result).includes('secret.har'));
});

test('single-tab recorder filters out other hosts and captures page WebSocket frames',async()=>{
  const page=new EventEmitter();
  const recorder=createNetworkRecorder(page,{urlFilter:url=>new URL(url).hostname==='demo.example.org'});
  const makeReq=url=>({url:()=>url,method:()=> 'GET',headers:()=>({}),postData:()=>null});
  page.emit('request',makeReq('https://unrelated.example.com/account?email=secret'));
  page.emit('request',makeReq('https://demo.example.org/spin?action=doSpin'));
  const ws=new EventEmitter();ws.url=()=> 'wss://demo.example.org/ws';page.emit('websocket',ws);
  ws.emit('framesent',{payload:'{"action":"doSpin"}'});
  const out=await recorder.finish();
  assert.equal(out.summary.requests,1);assert.equal(out.summary.webSocketFrames,1);
  assert.ok(!JSON.stringify(out.har).includes('unrelated.example.com'));
});
