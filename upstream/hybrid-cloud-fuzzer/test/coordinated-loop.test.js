import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {LoopController} from '../local/loop.js';
const source={id:'r:pragmatic:a:base',runId:'r',provider:'pragmatic',gameId:'a',shotId:'base',status:'classified',sourceSha256:'a'.repeat(64),revision:2,state:'BASE',mode:'structured',candidates:[],metadata:{},decisions:{allMarks:[{kind:'buy',label:'Buy bonus',x:.5,y:.5}]}};
test('Cloudflare execution ledger prevents replay from a new local journal',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'coordinated-loop-'));let executions=0,claimCalls=0;const ledger=[];
 const cloud={stats:async()=>({classified:1}),blockedGames:async()=>new Set(),allDecisions:async()=>[source],item:async()=>source,branchExecutions:async()=>ledger,
 claimBranch:async task=>{claimCalls++;ledger.push({task_id:task.id,status:'running'});return {acquired:true,token:'owner'};},
 uploadCapture:async info=>({item:{id:'child',gameId:info.gameId,shotId:info.shotId}}),uploadTrace:async()=>{},
 finishBranch:async(task,execution,status)=>{assert.equal(execution.token,'owner');ledger[0].status=status;}};
 const executor=async task=>{executions++;return {info:{gameId:task.gameId,shotId:task.shotId},image:Buffer.from('jpeg'),trace:{log:{entries:[],_webSockets:[]}}};};
 try{
  const config={cloud,executor,runId:'r',coordinated:true};
  assert.equal((await new LoopController({...config,outDir:path.join(dir,'first')}).once()).completed,1);
  assert.equal(ledger[0].status,'done');
  assert.equal((await new LoopController({...config,outDir:path.join(dir,'new-host')}).once()).completed,0);
  assert.equal(executions,1);assert.equal(claimCalls,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
