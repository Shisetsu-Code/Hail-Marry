// Durable, deterministic planning for human-reviewed branches in public demos.
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {safeHttps,writeAtomic,readJSON} from './utils.js';
import {reviewedAction,eligibleReviewedPath,isNormalClick} from '../src/action-plan.js';

const digest=v=>createHash('sha256').update(String(v)).digest('hex');
export function roundReady(counts){return Boolean(counts)&&Number(counts.pending||0)===0&&Number(counts.leased||0)===0&&Number(counts.needs_review||0)===0;}
export function makeTask(item,index){
 const action=reviewedAction(item,index);
 const ancestors=item.metadata?.actionPath||[];if(!Array.isArray(ancestors)||ancestors.length>20)throw Error('invalid ancestry');
 const actionPath=[...ancestors,action];
 const hash=digest(JSON.stringify([item.id,item.revision,item.sourceSha256,index,actionPath]));
 return {id:hash,shotId:'step-'+hash.slice(0,20),parentId:item.id,parentSourceSha256:item.sourceSha256,parentRevision:item.revision,
   runId:item.runId,provider:item.provider,gameId:item.gameId,sourceState:item.state,actionPath, path:actionPath,
   actionIndex:index,depth:actionPath.length};
}
export function collectTasks(items,known=new Set(),{maxDepth=7,maxTasks=2000,allowNormalSpin=false}={}){
 const tasks=[];for(const item of items){
  if(item?.status!=='classified'||item.metadata?.terminal===true)continue;
  const prev=item.metadata?.actionPath||[];
  if(prev.length>=maxDepth)continue;
  for(let i=0;i<(item.decisions?.allMarks||[]).length;i++){
   let task;try{task=makeTask(item,i);}catch{continue;}
   if(!eligibleReviewedPath(task.path.at(-1),prev,{maxDepth,allowNormalSpin}))continue;
   if(known.has(task.id))continue;
   tasks.push(task);if(tasks.length>=maxTasks)return tasks;
  }
 }
 return tasks;
}
export function resolveDemoUrl(item,{catalog=[]}={}){
 const approved=catalog.find(g=>g.id===item.gameId&&g.provider===item.provider&&g.enabled!==false);
 const original=item.metadata?.url||approved?.url||(item.provider==='pragmatic'?`https://www.pragmaticplay.fun/en/slots/${item.gameId}/`:null);
 if(!original)throw Error('public demo URL unavailable');
 let url=new URL(safeHttps(original));
 if(item.provider==='pragmatic'){
  if(url.hostname==='www.pragmaticplay.com'&&url.pathname===`/en/games/${item.gameId}/`&&approved){
   const target=new URL(safeHttps(approved.url));
   if(target.hostname==='www.pragmaticplay.fun'&&target.pathname===`/en/slots/${item.gameId}/`)url=target;
  }
  if(url.hostname!=='www.pragmaticplay.fun'||!/^\/en\/slots\/[a-z0-9-]+\/$/.test(url.pathname))throw Error('pragmatic demo host/path not approved');
 }else if(!approved || approved.url!==original){throw Error('non-Pragmatic demo must be explicitly listed in manifest');}
 return url.toString();
}
export function chooseAction(action,source,candidates,{aligned=false,state=null,visualMatched=false}={}){
 const knownConfirmation=state==='CONFIRM'&&/\/(?:BuyWindow\/Content\/.*\/Buttons\/ButtonYes|ConfirmWindow\/Buttons\/Button_Yes)$/i.test(action.controlPath||'');
 const knownBonusContinue=state==='BONUS'&&action.kind==='navigate'&&/\/FSWindows\/(?:FSStart|FSResult)\/ButtonContinue$/i.test(action.controlPath||'');
 const knownBonusChoice=state==='BONUS'&&action.state==='BASE'&&action.kind==='pick'&&/\/FreeSpins\/Bonus\/Content\/Buttons\/B_\d\//i.test(action.controlPath||'');
 if(!aligned||!state||(state!==action.state&&!(state==='UNKNOWN'&&visualMatched)&&!knownConfirmation&&!knownBonusChoice&&!knownBonusContinue))return null;
 if(action.visualReference&&!visualMatched)return null;
 if(!isNormalClick(action))return null;
 const savedCandidate=action.candidateId?source?.candidates?.find(c=>c.id===action.candidateId):null;
 const stablePath=action.controlPath||savedCandidate?.path;
 if(stablePath){
  const matches=candidates.filter(c=>c.path===stablePath&&c.confidence>=0.65&&c.rect);
  if(matches.length!==1)return null;
  const r=matches[0].rect;
  return {x:Number((r.x+r.w/2).toFixed(6)),y:Number((r.y+r.h/2).toFixed(6)),match:'runtime-path'};
 }
 if(action.candidateId){
  const matches=candidates.filter(c=>c.label===action.label&&c.confidence>=0.65&&c.rect);
  if(matches.length!==1)return null;
  const r=matches[0].rect;
  return {x:r.x+r.w/2,y:r.y+r.h/2,match:'runtime-label'};
 }
 // Coordinate-only marks are human reviewed; fail closed on unknown/changed state.
 if(state==='UNKNOWN'&&!visualMatched)return null;
 return {x:action.x,y:action.y,match:'reviewed-coordinate'};
}
export class RoundJournal{
 constructor(file,state){this.file=file;this.entries=state.entries||{};this.version=1;this.pendingWrite=Promise.resolve();}
 static async open(file){
  const saved=await readJSON(file,{entries:{}});const journal=new RoundJournal(file,saved);let altered=false;
  for(const entry of Object.values(journal.entries))if(entry.status==='running'){entry.status='uncertain';entry.reason='interrupted after action may have occurred';altered=true;}
  if(altered)await journal.flush();return journal;
 }
 status(id){return this.entries[id]?.status||'new';}
 shouldRun(task){return this.status(task.id)==='new';}
 async flush(){
  // Concurrent games must never race over writeAtomic's shared temporary file.
  const snapshot=JSON.parse(JSON.stringify({version:this.version,entries:this.entries}));
  this.pendingWrite=this.pendingWrite.then(()=>writeAtomic(this.file,snapshot));
  await this.pendingWrite;
 }
 async set(task,status,more={}){
  if(!['running','captured','done','uncertain','blocked','failed'].includes(status))throw Error('invalid task status');
  if(!task?.id)throw Error('missing task id');
  this.entries[task.id]={...(this.entries[task.id]||{}),task,status,...more,updatedAt:new Date().toISOString()};
  await this.flush();return this.entries[task.id];
 }
 summary(){const counts={};for(const e of Object.values(this.entries))counts[e.status]=(counts[e.status]||0)+1;return counts;}
}
export function traceEndpoints(har){
 return (har?.log?.entries||[]).map((e,index)=>({index,method:e.request?.method,url:e.request?.url,
  requestPayload:e.request?.postData?.text||null,status:e.response?.status??null,responsePayload:e.response?.content?.text||null,
  mime:e.request?.postData?.mimeType||null}));
}
export function classifyTrace(har){
 for(const entry of traceEndpoints(har)){
  const s=`${entry.url||''} ${entry.requestPayload||''}`;
  if(/\b(?:doSpin|doBonus|placeBet|gameSpin|spin_request|wager)\b/i.test(s))return 'bet_request_observed';
 }
 for(const frame of har?.log?._webSockets||[]){if(frame.direction==='sent'&&/\b(?:doSpin|doBonus|placeBet|gameSpin)\b/i.test(frame.payload||''))return 'bet_request_observed';}
 return 'next_state_captured';
}
// Preserve the complete sanitized HAR locally; bounded evidence travels to R2.
export function compactRemoteTrace(har,{maxBytes=300000}={}){
 if(!har?.log||!Number.isSafeInteger(maxBytes)||maxBytes<1000)throw Error('invalid HAR/size');
 const log={...har.log,entries:[...(har.log.entries||[])],_webSockets:[...(har.log._webSockets||[])]};
 const originalCount=log.entries.length;
 const isAction=e=>e?.request?.method!=='GET'||/\b(?:doSpin|doBonus|placeBet|wager|bet|spin)\b/i.test((e?.request?.url||'')+' '+(e?.request?.postData?.text||''));
 // Keep action requests preferentially; GET assets are replaced by a summary when oversized.
 if(JSON.stringify({log}).length>maxBytes){
  log.entries=log.entries.filter(isAction);
  log._truncated=true;
 }
 // If still excessive, retain the most recent entries and frames; action request occurs at the end.
 while(JSON.stringify({log}).length>maxBytes&&log.entries.length>1){log.entries.shift();log._truncated=true;}
 while(JSON.stringify({log}).length>maxBytes&&log._webSockets.length>1){log._webSockets.shift();log._truncated=true;}
 // Very large single bodies can be clipped without changing endpoint/method/action metadata.
 for(const entry of log.entries){
  if(JSON.stringify({log}).length<=maxBytes)break;
  if(entry.response?.content?.text){entry.response={...entry.response,content:{...entry.response.content,text:'[TRUNCATED]'}};log._truncated=true;}
 }
 if(JSON.stringify({log}).length>maxBytes)throw Error('action evidence too large even after compaction');
 if(log.entries.length!==originalCount)log._omittedEntries=originalCount-log.entries.length;
 return {log};
}
