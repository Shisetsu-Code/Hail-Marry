#!/usr/bin/env node
// One dynamically allocated local agent. D1 leases coordinate multiple hosts.
// Cloudflare never runs a browser, and the classifier never guesses from pixels.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {cli,writeAtomic,safeId,safeHttps} from './utils.js';
import {CloudClient} from './cloud-client.js';
import {classifyStructured} from './structured-classifier.js';
import {discoverPublicDemos,validateDiscoveryTicket} from './discover.js';
import {updateDrainRequested} from './update-drain.js';

const args=cli(process.argv.slice(2));
const role=String(args.role||'');
if(!['discovery','catalog','classification'].includes(role))throw Error('supported role: discovery/catalog/classification');
const runId=safeId(args.runId||args['run-id'],'runId');
const outDir=path.resolve(args.out||'outbox');
const cloud=new CloudClient({endpoint:process.env.HYBRID_FUZZER_URL,
 reviewToken:process.env.HYBRID_REVIEW_TOKEN,ingestToken:process.env.HYBRID_INGEST_TOKEN});
const workerId='agent-'+process.pid+'-'+randomUUID().slice(0,8);
const host='local'; // Avoid sending a user's machine hostname to Cloudflare.
const pollMs=Math.max(2000,Math.min(30000,Number(args['poll-ms']||6000)));
const waitMs=Math.max(450,Math.min(20000,Number(args['wait-ms']||6500)));
const speed=Math.max(1,Math.min(8,Number(args.speed||1)));
if(!Number.isFinite(pollMs)||!Number.isFinite(waitMs)||!Number.isFinite(speed))throw Error('invalid numeric argument');
let stopping=false;
process.on('SIGINT',()=>{stopping=true;});
process.on('SIGTERM',()=>{stopping=true;});
const errors=message=>console.error('WORKER '+role+' '+String(message));

async function subprocess(program,params){
 const child=spawn(process.execPath,[program,...params],{stdio:['ignore','pipe','pipe'],env:process.env,windowsHide:true});
 let out='',err='';
 const tail=(v,chunk)=>(v+chunk.toString('utf8')).slice(-6000);
 child.stdout.on('data',b=>{out=tail(out,b);});
 child.stderr.on('data',b=>{err=tail(err,b);});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(n,signal)=>resolve({n,signal}));});
 if(code.n!==0)throw Error('catalogue capture failed ('+code.n+'): '+err.slice(-400));
 return {output:out.slice(-600)};
}
async function catalogTicket(job){
 const game=job.payload?.game;
 if(!game||game.provider!==job.provider||game.id!==job.subject)throw Error('catalog ticket identity mismatch');
 safeId(game.id,'game id');safeId(game.provider,'provider');
 const url=new URL(safeHttps(game.url));
 if(url.search||url.hash||!url.hostname.includes('.'))throw Error('catalog game requires canonical public DEMO URL');
 const name=runId+'__'+job.provider+'__'+job.subject+'__base';
 const image=path.join(outDir,name+'.jpg'),meta=path.join(outDir,name+'.json');
 // A prior completed local capture can be uploaded later by the Sync worker.
 if(await fs.stat(meta).catch(()=>null)&&await fs.stat(image).catch(()=>null))return {cached:true,gameId:game.id};
 const tag=createHash('sha256').update(job.id).digest('hex').slice(0,24);
 const manifestFile=path.join(outDir,'.workforce','manifests',tag+'.json');
 await writeAtomic(manifestFile,{runId,games:[{provider:game.provider,id:game.id,url:game.url}]});
 const params=['--manifest='+manifestFile,'--out='+outDir,'--rate=3','--limit=1','--isolated-job',
  '--har=all','--wait-ms='+waitMs,'--speed='+speed];
 if(args['confirm-adult']===true)params.push('--confirm-adult');
 await subprocess(path.resolve('local/capture.mjs'),params);
 if(!(await fs.stat(meta).catch(()=>null))||!(await fs.stat(image).catch(()=>null)))
  throw Error('capture exited without durable JPEG + metadata');
 return {captured:true,gameId:game.id};
}
async function discoveryTicket(job){
 const source=validateDiscoveryTicket(job);
 const {chromium}=await import('playwright');
 const browser=await chromium.launch({headless:true});
 let result;
 try{result=await discoverPublicDemos(browser,source);}finally{await browser.close();}
 let queued=0;
 if(result.verifiedDemo){
  // Unverified providers are staged for review; do not launch unknown demo URLs.
  for(let i=0;i<result.games.length;i+=20){
   const jobs=result.games.slice(i,i+20).map(game=>({role:'catalog',provider:game.provider,subject:game.gameId,
    priority:10,payload:{game:{provider:game.provider,id:game.gameId,url:game.url}}}));
   queued+=(await cloud.enqueueWork(runId,jobs)).inserted;
  }
 }
 return {provider:source.provider,found:result.games.length,queued,verifiedDemo:result.verifiedDemo,
  examples:result.games.slice(0,5)};
}
async function structuredTicket(){
 const item=await cloud.claimStructured(runId,900);
 if(!item)return false;
 try{
  const decision=classifyStructured(item);
  if(!decision.eligible){
   // The filtered claim should never return non-structured entries.
   await cloud.releaseCapture(item);throw Error('non-eligible auto-classification capture');
  }
  await cloud.saveStructured(item,decision);
  console.log('CLASSIFIED '+item.provider+'/'+item.gameId+' '+decision.status+
   ' candidates='+decision.selections.length);
 }catch(e){
  await cloud.releaseCapture(item).catch(()=>{});
  throw e;
 }
 return true;
}
async function queuedTicket(){
 const job=await cloud.claimWork(runId,role,workerId,{leaseSeconds:900});
 if(!job)return false;
 // Long-running public demos can exceed 5 min. Never re-run on a live lease:
 // refresh while work is in progress and only complete against the exact token.
 const heartbeat=setInterval(()=>{
  cloud.renewWork(job,workerId,900).catch(e=>errors('LEASE RENEW '+job.id+' '+e.message));
 },60000);
 let ok=false,result=null,error=null;
 try{
  result=role==='catalog'?await catalogTicket(job):await discoveryTicket(job);
  ok=true;
 }catch(e){error=String(e?.message||e).slice(0,300);}
 finally{clearInterval(heartbeat);}
 try{
  const finished=await cloud.finishWork(job,workerId,{ok,result,error});
  console.log('TICKET '+role+' '+job.provider+'/'+job.subject+' '+finished.status);
 }catch(e){errors('FINISH '+job.id+' '+e.message);}
 if(!ok)errors(job.id+' '+error);
 return true;
}
let lastHeartbeat=0;
try{
 while(!stopping){
  if(await updateDrainRequested()){stopping=true;break;}
  try{
   if(Date.now()-lastHeartbeat>25000){
    await cloud.agentHeartbeat(runId,workerId,role,host);
    lastHeartbeat=Date.now();
   }
   const progress=role==='classification'?await structuredTicket():await queuedTicket();
   if(!progress&&!stopping)await sleep(pollMs);
  }catch(e){
   errors(e.message);
   if(!stopping)await sleep(pollMs);
  }
 }
}finally{console.log('AGENT STOP '+role+' '+workerId);}
