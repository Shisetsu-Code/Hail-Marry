#!/usr/bin/env node
// Classifier -> Playwright demo action -> sanitized HTTP evidence -> Cloudflare -> next round.
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {cli,safeId,withLock,RateLimiter} from './utils.js';
import {CloudClient} from './cloud-client.js';
import {LoopController} from './loop.js';
import {executeDemoBranch} from './branch-executor.js';
import {validateSpeed} from './speed.js';
import {updateDrainRequested} from './update-drain.js';

const args=cli(process.argv.slice(2));
if(args.help){console.log('node local/round-runner.mjs --manifest=examples/demos.json --out=outbox --watch --limit=5 --interval-ms=15000 [--headed] [--speed=4] [--confirm-adult]');process.exit(0);}
const output=path.resolve(args.out||'outbox'),manifestPath=path.resolve(args.manifest||'examples/demos.json');
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));safeId(manifest.runId,'runId');
const url=args.url||process.env.HYBRID_FUZZER_URL,reviewToken=process.env.HYBRID_REVIEW_TOKEN,ingestToken=process.env.HYBRID_INGEST_TOKEN;
const cloud=new CloudClient({endpoint:url,reviewToken,ingestToken});
const speed=validateSpeed(args.speed||1),limit=Number(args.limit||5),interval=Number(args['interval-ms']||15000);
const waitMs=Number(args['wait-ms']||850),maxDepth=Number(args['max-depth']||7),concurrency=Number(args.concurrency||8);
if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>32)throw Error('--concurrency must be 1..32');
if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(interval)||interval<3000||!Number.isSafeInteger(waitMs)||waitMs<450||waitMs>10000||!Number.isSafeInteger(maxDepth)||maxDepth<1||maxDepth>7)throw Error('invalid CLI numeric arguments; coordinated max-depth must be 1..7');
if(args['allow-normal-spin']===true)throw Error('normal spins are excluded by the coordinated continuation policy');
let stop=false;const signal=()=>{stop=true;};process.on('SIGINT',signal);process.on('SIGTERM',signal);
const run=async()=>{
 const {chromium}=await import('playwright');
 const browser=await chromium.launch({headless:args.headed!==true});
 const limiter=new RateLimiter(path.join(output,'.throttle.json'),{maxPerMinute:3});
 const worker=new LoopController({cloud,runId:manifest.runId,outDir:output,limit,maxDepth,concurrency,coordinated:true,allowNormalSpin:args['allow-normal-spin']===true,
 reserve:async task=>{
  const workerId='branch-'+task.id;
   if(stop||await updateDrainRequested())throw Error('continuation stopped before browser action');
  const session=await cloud.call('/v1/work/provider/lease',{method:'POST',body:JSON.stringify({provider:task.provider,runId:task.runId,gameId:task.gameId,workerId,leaseSeconds:900})});
  return session.granted?{session,workerId}:{deferred:true,reason:session.reason};
 },
 release:async(_task,{session,workerId})=>{await cloud.call('/v1/work/provider/release',{method:'POST',body:JSON.stringify({leaseId:session.leaseId,workerId})});},
 executor:async(task,source,{session,workerId})=>{
  await limiter.reserve();
  const renew=()=>cloud.call('/v1/work/provider/renew',{method:'POST',body:JSON.stringify({leaseId:session.leaseId,workerId,leaseSeconds:900})});
  let lastRenew=Date.now();
  const keepAlive=async()=>{if(Date.now()-lastRenew>=30000){await renew();lastRenew=Date.now();}};
  return executeDemoBranch(task,source,{browser,manifest:manifest.games,waitMs,speed,confirmAdult:args['confirm-adult']===true,beforeClick:renew,keepAlive,loadReviewedImage:reference=>cloud.reviewedImage(reference)});
 }});
 try{do{
  if(await updateDrainRequested())break;
  try{const res=await worker.once();console.log('ROUND',JSON.stringify(res));}
  catch(e){console.error('ROUND ERROR',e.message);if(!args.watch)throw e;}
  if(args.watch&&!stop)await sleep(interval);
 }while(args.watch&&!stop);}finally{await browser.close();}
};
try{await withLock(path.join(output,'.round-runner.lock'),run);}finally{process.off('SIGINT',signal);process.off('SIGTERM',signal);}
