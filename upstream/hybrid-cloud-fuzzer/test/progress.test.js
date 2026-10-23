import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeProgress} from '../src/progress.js';
import {mergeProgress} from '../local/progress.js';
const row=(extra={})=>({id:'r:pragmatic:alpha:base',revision:2,source_sha256:'a'.repeat(64),provider:'pragmatic',game_id:'alpha',state:'BASE',status:'classified',decisions_json:JSON.stringify({allMarks:[{kind:'buy',label:'BUY FREE SPINS',x:.1,y:.2},{kind:'other',label:'ANTE BET HIGHER CHANCE',x:.2,y:.3}]}),metadata_json:'{}',...extra});
test('provider progress deduplicates controls and does not call a capture a finished game',()=>{
 const p=summarizeProgress([row(),row(),row({game_id:'beta',status:'pending'})]);
 assert.equal(p.games[0].buys,1);assert.equal(p.games[0].anteBets,1);
 assert.equal(p.games[0].finished,false);assert.equal(p.providers[0].processed,1);
 assert.equal(p.providers[0].pending,1);
});
test('observed demo request only finishes after pending review is resolved',()=>{
 const terminal=row({metadata_json:JSON.stringify({terminal:true,evidenceStatus:'bet_request_observed'})});
 assert.equal(summarizeProgress([terminal]).games[0].evidence,1);
 assert.equal(summarizeProgress([terminal]).games[0].finished,false);
 assert.equal(summarizeProgress([terminal,row({status:'needs_review'})]).games[0].finished,false);
});
test('local panel includes uncaptured manifest games and isolates blocked or uncertain history',()=>{
 const cloud={...summarizeProgress([row()]),runId:'r'};
 const p=mergeProgress(cloud,{runId:'r',games:[{provider:'pragmatic',id:'alpha'},{provider:'pragmatic',id:'beta'}]},
  {entries:{a:{task:{runId:'r',provider:'pragmatic',gameId:'alpha'},status:'uncertain'}}});
 assert.equal(p.games.find(g=>g.gameId==='alpha').state,'Incierto');
 assert.equal(p.games.find(g=>g.gameId==='beta').state,'Sin captura');
 assert.equal(p.providers[0].total,2);assert.equal(p.providers[0].unfinished,2);
});
test('journal entries from another run cannot block or inflate this run',()=>{
 const cloud={...summarizeProgress([row()]),runId:'r'};
 const p=mergeProgress(cloud,{runId:'r',games:[]},{entries:{a:{status:'uncertain',task:{runId:'other',provider:'pragmatic',gameId:'alpha'}}}});
 assert.equal(p.games[0].uncertain,0);assert.equal(p.games[0].remainingActions,2);
});
test('observed request does not finish a game with an unexecuted sibling',()=>{
 const cloud={...summarizeProgress([row(),row({id:'child',metadata_json:JSON.stringify({terminal:true,evidenceStatus:'bet_request_observed'})})]),runId:'r'};
 const p=mergeProgress(cloud,{runId:'r',games:[]});
 assert.equal(p.games[0].finished,false);assert.equal(p.games[0].remainingActions,2);
 const entries=Object.fromEntries([0,1].map(index=>[index,{status:'done',task:{runId:'r',provider:'pragmatic',gameId:'alpha',parentId:row().id,parentRevision:2,parentSourceSha256:row().source_sha256,actionIndex:index}}]));
 assert.equal(mergeProgress(cloud,{runId:'r',games:[]},{entries}).games[0].finished,true);
});
test('progress excludes the same repeated ancestor controls as the executor',()=>{
 const cloud={...summarizeProgress([row({metadata_json:JSON.stringify({actionPath:[{state:'BASE',kind:'buy',label:'BUY FREE SPINS'}]})})]),runId:'r'};
 const p=mergeProgress(cloud,{runId:'r',games:[]});
 assert.equal(p.games[0].remainingActions,1);
});
