import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForCaptureReady} from '../local/capture-ready.js';
const sample=(count,adapter='pragmatic-runtime')=>({frame:{},data:{adapter,state:'BASE',candidates:Array(count).fill({}),metadata:{opaqueCanvas:true}}});
test('waits beyond a blank runtime BASE until controls are available',async()=>{
 let reads=0,cleanups=0;
 const ready=sample(2);
 const result=await waitForCaptureReady({},'pragmatic',{inspect:async()=>++reads<3?sample(0):ready,cleanup:async()=>cleanups++,sleep:async()=>{},timeoutMs:20,pollMs:1});
 assert.equal(result,ready);assert.ok(reads>=3);assert.equal(cleanups,reads);
});
test('never captures a permanent loading canvas, even if labelled BASE',async()=>{
 await assert.rejects(()=>waitForCaptureReady({},'pragmatic',{inspect:async()=>sample(0),cleanup:async()=>{},sleep:async()=>{},timeoutMs:2,pollMs:1}),/loading|ready/i);
});
test('opaque fallback without controls is not proof that a Pragmatic game loaded',async()=>{
 await assert.rejects(()=>waitForCaptureReady({},'pragmatic',{inspect:async()=>sample(0,'generic-dom'),cleanup:async()=>{},sleep:async()=>{},timeoutMs:2,pollMs:1}),/loading|ready/i);
});
test('does not change screenshot fallback for other providers',async()=>{
 const value=sample(0,'generic-dom');assert.equal(await waitForCaptureReady({},'other',{inspect:async()=>value}),value);
});

test('explicit loading is awaited for every provider, not only Pragmatic',async()=>{
 let reads=0;const ready=sample(1,'generic-dom');
 assert.equal(await waitForCaptureReady({},'bgaming',{inspect:async()=>++reads<3?{data:{state:'LOADING'}}:ready,sleep:async()=>{},timeoutMs:10,pollMs:1}),ready);
 assert.equal(reads,3);
});
