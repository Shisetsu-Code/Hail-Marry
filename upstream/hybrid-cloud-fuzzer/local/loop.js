import fs from 'node:fs/promises';
import path from 'node:path';
import {RoundJournal,collectTasks,compactRemoteTrace} from './rounds.js';
import {writeAtomic} from './utils.js';
import {updateDrainRequested} from './update-drain.js';

// Each (runId, provider, gameId) is its own classification/execution barrier.
// A stalled game cannot prevent ready games from exploring reviewed DEMO paths.
// A single interrupted/uncertain action is never repeated automatically.
const gameKey=item=>item.provider+'/'+item.gameId;

export class LoopController{
 constructor({cloud,executor,runId,outDir='outbox',limit=20,maxDepth=7,concurrency=8,reserve=async()=>null,release=async()=>{},allowNormalSpin=false,coordinated=false,log=console.log}={}){
  if(!runId||!cloud||!executor)throw Error('runId, cloud and executor required');
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>32)throw Error('concurrency must be 1..32');
  Object.assign(this,{cloud,executor,runId,outDir:path.resolve(outDir),limit,maxDepth,concurrency,reserve,release,allowNormalSpin,coordinated,log});
 }
 async uploadSaved(entry,journal){
  const {task,itemFile,imageFile,traceFile}=entry;
  const info=JSON.parse(await fs.readFile(itemFile,'utf8'));
  const image=await fs.readFile(imageFile);
  const trace=JSON.parse(await fs.readFile(traceFile,'utf8'));
  const uploaded=await this.cloud.uploadCapture(info,image);
  if(uploaded.item?.gameId!==task.gameId||uploaded.item?.shotId!==task.shotId)throw Error('remote capture identity mismatch');
  await this.cloud.uploadTrace({traceId:task.id,runId:task.runId,provider:task.provider,gameId:task.gameId,parentId:task.parentId,
   parentSourceSha256:task.parentSourceSha256,parentRevision:task.parentRevision,childId:uploaded.item.id,trace:compactRemoteTrace(trace)});
  if(this.coordinated){
   if(!entry.execution?.token)throw Error('missing durable execution ownership');
   await this.cloud.finishBranch(task,entry.execution,'done',{childId:uploaded.item.id});
  }
  await journal.set(task,'done');
 }
 async once(){
  await fs.mkdir(this.outDir,{recursive:true});
  const journal=await RoundJournal.open(path.join(this.outDir,'.round-journal.json'));
  let blocked=0,completed=0,deferred=0;
  const localBlocked=new Set();

  // Retried uploads are idempotent; *never* re-execute the associated click.
  // An error belongs to this game only. Keep servicing unrelated games.
  for(const entry of Object.values(journal.entries)){
   if(!entry.task)continue;
   const key=gameKey(entry.task);
   if(entry.status==='captured'){
    localBlocked.add(key); // child needs to be reviewed before this game advances
    try{
     await this.uploadSaved(entry,journal);
     completed++;
    }catch(e){
     blocked++;
     this.log('UPLOAD RETRY '+entry.task.id+': '+e.message);
    }
   }else if(['uncertain','blocked','failed'].includes(entry.status)){
    // Operator investigation is required for this game; other games are not stalled.
    localBlocked.add(key);
   }
  }

  // Required: a fresh server-side per-game snapshot of all unresolved captures.
  // Do not fall back to assuming "ready" when this query or paging fails.
  const counts=await this.cloud.stats(this.runId);
  const remoteBlocked=await this.cloud.blockedGames(this.runId);
  if(!(remoteBlocked instanceof Set))throw Error('invalid per-game readiness response');
  const blockedKeys=new Set([...remoteBlocked,...localBlocked]);

  // Fetch classified decisions for *ready* games. A replaced or stale item in
  // one game is quarantined without making other games lose their progress.
  const rows=await this.cloud.allDecisions(this.runId);
  const actionable=rows.filter(d=>d.decisions?.allMarks?.length&&!blockedKeys.has(gameKey(d)));
  const items=[];
  for(let i=0;i<actionable.length;i+=8){
   const slice=actionable.slice(i,i+8);
   const chunk=await Promise.allSettled(slice.map(d=>this.cloud.item(d.id)));
   for(let j=0;j<chunk.length;j++){
    const d=slice[j],result=chunk[j],key=gameKey(d);
    if(result.status!=='fulfilled'){
     blockedKeys.add(key);
     blocked++;
     this.log('GAME WAIT '+key+': source unavailable ('+String(result.reason?.message||result.reason)+')');
     continue;
    }
    const item=result.value;
    if(!item||item.status!=='classified'||item.revision!==d.revision||item.sourceSha256!==d.sourceSha256){
     blockedKeys.add(key);
     blocked++;
     this.log('GAME WAIT '+key+': classification changed since feed');
     continue;
    }
    items.push(item);
   }
  }

  // Only one branch per game per polling round, so after publishing a child
  // its own classification is the next prerequisite. Other games run normally.
  const known=new Set(Object.keys(journal.entries));
  if(this.coordinated)for(const entry of await this.cloud.branchExecutions(this.runId))known.add(entry.task_id);
  const tasks=collectTasks(items.filter(x=>!blockedKeys.has(gameKey(x))),known,{
   maxDepth:this.maxDepth,maxTasks:3000,allowNormalSpin:this.allowNormalSpin
  });
  const selected=[],selectedGames=new Set();
  const byProvider=new Map();
  for(const task of tasks){if(!byProvider.has(task.provider))byProvider.set(task.provider,[]);byProvider.get(task.provider).push(task);}
  const fair=[];
  while([...byProvider.values()].some(q=>q.length))for(const queue of byProvider.values())if(queue.length)fair.push(queue.shift());
  for(const task of fair){
   const key=gameKey(task);
   if(blockedKeys.has(key)||selectedGames.has(key))continue;
   selected.push(task);selectedGames.add(key);
   if(selected.length>=this.limit)break;
  }
  const sources=new Map(items.map(i=>[i.id,i]));
  const execute=async task=>{
   if(await updateDrainRequested())return;
   const key=gameKey(task);
   let execution=null,reservation=null;
   try{
    const source=sources.get(task.parentId);
    reservation=await this.reserve(task,source);
    if(reservation?.deferred){deferred++;return;}
    if(this.coordinated){execution=await this.cloud.claimBranch(task);if(!execution.acquired){this.log('BRANCH WAIT '+task.gameId+': '+execution.status);return;}}
    await journal.set(task,'running',execution?{execution}:{});
    const capture=await this.executor(task,source,reservation);
    const prefix=task.runId+'__'+task.provider+'__'+task.gameId+'__'+task.shotId;
    const itemFile=path.join(this.outDir,prefix+'.json'),imageFile=path.join(this.outDir,prefix+'.jpg'),traceFile=path.join(this.outDir,'diagnostics',prefix+'.har');
    await fs.mkdir(path.dirname(traceFile),{recursive:true});
    await fs.writeFile(imageFile+'.tmp',capture.image);await fs.rename(imageFile+'.tmp',imageFile);
    await writeAtomic(itemFile,capture.info);await writeAtomic(traceFile,capture.trace);
    await journal.set(task,'captured',{itemFile,imageFile,traceFile});
    await this.uploadSaved(journal.entries[task.id],journal);
    completed++;
    this.log('BRANCH DONE '+task.gameId+' '+task.shotId+' depth='+task.depth);
   }catch(e){
    // No automatic retry once there is any possibility a click occurred.
    if(journal.status(task.id)==='running'){
     await journal.set(task,e.actionIssued?'uncertain':'blocked',{reason:String(e.message).slice(0,240)});
     if(execution?.token)await this.cloud.finishBranch(task,execution,e.actionIssued?'uncertain':'blocked',{reason:String(e.message).slice(0,300)}).catch(error=>this.log('REMOTE EXECUTION REMAINS RESERVED: '+error.message));
    }
    blocked++;
    blockedKeys.add(key);
    this.log('GAME STOPPED '+task.gameId+'/'+task.shotId+': '+e.message);
   }finally{if(reservation&&!reservation.deferred)await this.release(task,reservation);}
  };
  // Independent games overlap loading and bonus waits; a game still has exactly
  // one branch in flight, protected by the same durable execution ownership.
  let cursor=0;
  const workers=await Promise.allSettled(Array.from({length:Math.min(this.concurrency,selected.length)},async()=>{
   while(cursor<selected.length){const task=selected[cursor++];await execute(task);}
  }));
  const failures=workers.filter(r=>r.status==='rejected');
  if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'branch worker persistence failed');
  return {
   completed,blocked,deferred,blockedGames:blockedKeys.size,
   waiting:selected.length===0,
   reason:selected.length?'executed':blockedKeys.size?'await-game-classification-or-review':'idle',
   scheduled:tasks.length,scheduledGames:selected.length,
   counts:journal.summary(),cloudCounts:counts
  };
 }
}
