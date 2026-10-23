import test from 'node:test';
import assert from 'node:assert/strict';
import {screenPoint,actionEvidence,executeDemoBranch} from '../local/branch-executor.js';

test('executor refuses legacy cookie ancestry before opening a browser or clicking',async()=>{
 let launched=false;
 await assert.rejects(()=>executeDemoBranch({path:[{label:'Reject All cookies',kind:'navigate'}]}, {},
  {chromium:{launch:async()=>{launched=true;throw Error('unexpected browser');}}}),/consent.*branch/);
 assert.equal(launched,false);
});
test('normalized clicks are applied to a clipped and aligned game frame, not outer document',()=>{
 assert.deepEqual(screenPoint({x:.3,y:.6},{clip:{x:100,y:70,width:800,height:450},aligned:true}),{x:340,y:340});
 assert.throws(()=>screenPoint({x:.3,y:.6},{clip:null,aligned:false}),/alignment/i);
 assert.throws(()=>screenPoint({x:1.2,y:.6},{clip:null,aligned:true}),/coordinates/i);
});
test('action evidence reports a witnessed demo spin, but never calls it a validated round',()=>{
 const har={log:{entries:[{request:{method:'POST',url:'https://example.com/logic?action=doSpin',postData:{mimeType:'application/x-www-form-urlencoded',text:'action=doSpin&bet=2'}},response:{status:200,content:{text:'{"rs":"mc"}'}}}],_webSockets:[]}};
 const r=actionEvidence(har);assert.equal(r.status,'bet_request_observed');assert.equal(r.endpoints.length,1);assert.equal(r.endpoints[0].method,'POST');
 assert.ok(r.validated!==true);
});
