import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {makeTask, collectTasks, chooseAction, roundReady, resolveDemoUrl, RoundJournal, classifyTrace, traceEndpoints, compactRemoteTrace} from '../local/rounds.js';
import {prepareReplay, replayTrace} from '../local/replay.js';

const base={id:'r:pragmatic:alpha:base',runId:'r',provider:'pragmatic',gameId:'alpha',shotId:'base',status:'classified',revision:2,sourceSha256:'a'.repeat(64),state:'BASE',candidates:[{id:'c1',label:'BUY FREE SPINS',path:'Game/Buy',confidence:.92,rect:{x:.1,y:.2,w:.2,h:.1}}],metadata:{url:'https://www.pragmaticplay.fun/en/slots/alpha/'},decisions:{allMarks:[{candidateId:'c1',kind:'buy',label:'BUY FREE SPINS',x:.2,y:.25}]}};
test('round does not advance while pending, leased, or review entries exist',()=>{
 for(const c of [{pending:1,leased:0,needs_review:0},{pending:0,leased:1,needs_review:0},{pending:0,leased:0,needs_review:1}])assert.equal(roundReady(c),false);
 assert.equal(roundReady({pending:0,leased:0,needs_review:0,classified:216}),true);
});
test('task IDs are stable, use reviewed source hash and preserve actionable path',()=>{
 const task=makeTask(base,0);
 assert.equal(task.id,makeTask(base,0).id);assert.match(task.shotId,/^step-[a-f0-9]{20}$/);
 assert.deepEqual(task.path,[{kind:'buy',label:'BUY FREE SPINS',x:.2,y:.25,state:'BASE',controlPath:'Game/Buy',candidateId:'c1'}]);
 assert.equal(task.parentSourceSha256,base.sourceSha256);
 assert.equal(makeTask({...base,sourceSha256:'b'.repeat(64)},0).id===task.id,false);
});
test('cloud allMarks recovers selected candidate path from decisions.selections',()=>{
 const live={...base,decisions:{selections:[{candidateId:'c1',kind:'buy',label:'BUY FREE SPINS',x:.2,y:.25}],marks:[],allMarks:[{kind:'buy',label:'BUY FREE SPINS',x:.2,y:.25}]}};
 assert.equal(makeTask(live,0).path[0].controlPath,'Game/Buy');
});
test('sibling branches and child ancestry remain separate and stop at depth',()=>{
 const two={...base,decisions:{allMarks:[{x:.2,y:.3,kind:'buy',label:'Bonus A'},{x:.8,y:.3,kind:'buy',label:'Bonus B'}]}};
 const tasks=collectTasks([two],new Set(),{maxDepth:4});assert.equal(tasks.length,2);assert.notEqual(tasks[0].id,tasks[1].id);
 const child={...base,shotId:'step-child',metadata:{actionPath:tasks[0].path},decisions:{allMarks:[{x:.5,y:.5,kind:'navigate',label:'Confirm'}]}};
 const next=makeTask(child,0);assert.equal(next.path.length,2);
 assert.equal(collectTasks([{...child,metadata:{actionPath:Array(4).fill(tasks[0].path[0])}}],new Set(),{maxDepth:4}).length,0);
});
test('selection matches the current runtime path and refuses ambiguous or misaligned coordinates',()=>{
 const target=makeTask(base,0).path[0];
 const current=[{id:'c9',path:'Game/Buy',label:'BUY FREE SPINS',confidence:.93,rect:{x:.11,y:.21,w:.18,h:.09}}];
 assert.deepEqual(chooseAction(target,base,current,{aligned:true,state:'BASE'}),{x:.2,y:.255,match:'runtime-path'});
 assert.equal(chooseAction(target,base,current.concat({...current[0],id:'c10'}),{aligned:true,state:'BASE'}),null);
 assert.equal(chooseAction(target,base,current,{aligned:false,state:'BASE'}),null);
 assert.equal(chooseAction(target,base,current,{aligned:true,state:'INTRO'}),null);
 assert.equal(chooseAction({x:.3,y:.4,state:'BASE',kind:'navigate',label:'Open'},base,[],{aligned:true,state:'BASE'}).match,'reviewed-coordinate');
});
test('URLs are public HTTPS demos only',()=>{
 assert.equal(resolveDemoUrl(base),base.metadata.url);
 assert.throws(()=>resolveDemoUrl({...base,metadata:{url:'https://127.0.0.1/game'}}));
 assert.throws(()=>resolveDemoUrl({...base,metadata:{url:'https://real-casino.example/wager'}}));
 assert.equal(resolveDemoUrl({...base,metadata:{}}),'https://www.pragmaticplay.fun/en/slots/alpha/');
});
test('crash while executing is uncertain and must not repeat action automatically',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'round-test-'));
 try{const file=path.join(dir,'state.json'),task=makeTask(base,0);const j=await RoundJournal.open(file);await j.set(task,'running');
 const r=await RoundJournal.open(file);assert.equal(r.status(task.id),'uncertain');assert.equal(r.shouldRun(task),false);
 await r.set(task,'captured',{itemFile:'/out/result.json'});const s=await RoundJournal.open(file);assert.equal(s.status(task.id),'captured');assert.equal(s.shouldRun(task),false);
 await s.set(task,'done');assert.equal((await RoundJournal.open(file)).status(task.id),'done');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('trace links action to ordered endpoints and marks observed wager without claiming validation',()=>{
 const trace={log:{entries:[{request:{method:'POST',url:'https://demo.example/game?command=doSpin',postData:{text:'action=doSpin&bet=1'}},response:{status:200,content:{text:'{"win":0}'}}}],_webSockets:[]}};
 assert.equal(classifyTrace(trace),'bet_request_observed');const rows=traceEndpoints(trace);
 assert.equal(rows[0].method,'POST');assert.equal(rows[0].requestPayload,'action=doSpin&bet=1');assert.equal(rows[0].status,200);
});
test('network-only replay is fail-closed for redactions and needs explicit mutating approval',async()=>{
 const evidence={log:{entries:[{request:{method:'POST',url:'https://demo.example/spin',postData:{text:'action=doSpin&bet=1',mimeType:'application/x-www-form-urlencoded'}},response:{status:200}}]}};
 assert.equal(prepareReplay(evidence,{allowedOrigins:['https://demo.example']}).length,1);
 await assert.rejects(()=>replayTrace(evidence,{allowedOrigins:['https://demo.example'],fetcher:async()=>{throw Error('should not call')}}),/allowMutating/);
 await assert.rejects(()=>replayTrace({log:{entries:[{request:{method:'POST',url:'https://demo.example/spin',postData:{text:'token=%5BREDACTED%5D'}}}]}},{allowedOrigins:['https://demo.example'],allowMutating:true,fetcher:async()=>{throw Error('should not call')}}),/redact|sensitive/i);
 await assert.rejects(()=>replayTrace(evidence,{allowedOrigins:['https://other.example'],allowMutating:true,fetcher:async()=>{throw Error('should not call')}}),/origin/i);
});
test('remote evidence is bounded without losing the most recent wager request; local HAR retains everything',()=>{
 const entries=Array.from({length:220},(_,i)=>({request:{method:i===219?'POST':'GET',url:'https://demo.example/'+i,postData:i===219?{text:'action=doSpin&bet=5'}:undefined},response:{status:200,content:{text:'a'.repeat(4000)}}}));
 const original={log:{version:'1.2',entries,_webSockets:[],_notice:'Sanitized DEMO diagnostics'}};
 const remote=compactRemoteTrace(original,{maxBytes:80000});
 assert.ok(JSON.stringify(remote).length<=80000);
 assert.equal(classifyTrace(remote),'bet_request_observed');assert.equal(original.log.entries.length,220);
 assert.equal(remote.log._truncated,true);
});

test('incorrect routine Spin/Autoplay/settings marks are not executed as exploration branches',()=>{
 const candidates=[{id:'s',label:'Spin_Normal',path:'Game/SpinButton'},{id:'a',label:'Autoplay',path:'Game/AutoPlay'},{id:'b',label:'Buy Free Spins',path:'Game/FeaturePurchase'}];
 const decisions={allMarks:candidates.map((c,i)=>({kind:'navigate',label:c.label,x:.1+i*.2,y:.5,candidateId:c.id}))};
 const item={...base,candidates,decisions};
 assert.equal(collectTasks([item]).length,1);assert.equal(collectTasks([item],new Set(),{allowNormalSpin:true}).length,2);
});


test('Spanish routine controls are excluded without discarding purchases or antebets',()=>{
 const labels=['Girar','Men\u00fa','Autoplay','Aumentar apuesta','Reducir apuesta','Buy Free Spins $200','Ante bet'];
 const item={...base,candidates:[],decisions:{allMarks:labels.map(label=>({kind:'other',label,x:.5,y:.5}))}};
 assert.deepEqual(collectTasks([item]).map(t=>t.path.at(-1).label),['Menú','Buy Free Spins $200','Ante bet']);
});


test('Pragmatic corporate capture URLs require the matching explicit public demo in the manifest',()=>{
 const item={...base,metadata:{url:'https://www.pragmaticplay.com/en/games/'+base.gameId+'/'}};
 const url='https://www.pragmaticplay.fun/en/slots/'+base.gameId+'/';
 assert.equal(resolveDemoUrl(item,{catalog:[{provider:'pragmatic',id:base.gameId,url}]}),url);
 assert.throws(()=>resolveDemoUrl(item));
});


test('unknown-state coordinate marks await a runtime adapter instead of becoming execution attempts',()=>{
 const item={...base,state:'UNKNOWN',candidates:[],decisions:{allMarks:[{kind:'navigate',label:'Continue',x:.5,y:.5}]}};
 assert.equal(collectTasks([item]).length,0);
});

test('classified opaque screens bind coordinate replay to their immutable JPEG and current revision',()=>{
 const item={...base,state:'UNKNOWN',hasImage:true,imageSha256:'b'.repeat(64),candidates:[],decisions:{allMarks:[{kind:'navigate',label:'Continue',x:.5,y:.5}]}};
 const [task]=collectTasks([item]);assert.ok(task);
 assert.deepEqual(task.path[0].visualReference,{itemId:item.id,revision:2,sourceSha256:item.sourceSha256,imageSha256:item.imageSha256});
 assert.equal(chooseAction(task.path[0],item,[],{aligned:true,state:'UNKNOWN'}),null);
 assert.equal(chooseAction(task.path[0],item,[],{aligned:true,state:'UNKNOWN',visualMatched:true}).match,'reviewed-coordinate');
});

test('a reviewed BASE coordinate can match an opaque UNKNOWN adapter only with verified pixels',()=>{
 const step={kind:'buy',label:'Buy bonus',state:'BASE',x:.2,y:.2,visualReference:{}};
 assert.equal(chooseAction(step,null,[],{aligned:true,state:'UNKNOWN'}),null);
 assert.ok(chooseAction(step,null,[],{aligned:true,state:'UNKNOWN',visualMatched:true}));
 assert.equal(chooseAction(step,null,[],{aligned:true,state:'CONFIRM',visualMatched:true}),null);
});
