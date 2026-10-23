#!/usr/bin/env node
// Dynamically scales LOCAL role processes based on live D1 workload.
// Cloudflare is the queue/lease control plane; browsers do not run in Workers.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {cli,readJSON,writeAtomic,safeId} from './utils.js';
import {planWorkforce,WORK_ROLES} from './work-allocation.js';
import {CloudClient} from './cloud-client.js';
import {validateDiscoverySource,discoveryTicketSubject} from './discover.js';
import {updateDrainRequested} from './update-drain.js';

const args=cli(process.argv.slice(2));
if(args.help){
 console.log('node local/workforce.mjs --manifest=FILE --providers=FILE --out=outbox --max-workers=5 --browser-workers=3 --watch [--confirm-adult]');
 process.exit(0);
}
const manifestFile=path.resolve(args.manifest||'examples/demos.json');
const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
const runId=safeId(manifest.runId,'runId'),outDir=path.resolve(args.out||'outbox');
if(!Array.isArray(manifest.games))throw Error('manifest.games required');
const providersFile=path.resolve(args.providers||'examples/provider-sources.json');
const sources=(await readJSON(providersFile,{sources:[]})).sources;
if(!Array.isArray(sources))throw Error('providers sources must be an array');
const maxWorkers=Number(args['max-workers']||5),browserWorkers=Number(args['browser-workers']||3);
const interval=Number(args['interval-ms']||15000),speed=Number(args.speed||1),waitMs=Number(args['wait-ms']||6500);
const discoveryEveryMinutes=Number(args['discovery-minutes']||360);
if(!Number.isSafeInteger(interval)||interval<3000||interval>60000||
 !Number.isSafeInteger(discoveryEveryMinutes)||discoveryEveryMinutes<30||discoveryEveryMinutes>10080)
 throw Error('invalid supervisor interval/discovery cadence');
const cloud=new CloudClient({endpoint:process.env.HYBRID_FUZZER_URL,
 reviewToken:process.env.HYBRID_REVIEW_TOKEN,ingestToken:process.env.HYBRID_INGEST_TOKEN});
const perRoleMax={discovery:1,catalog:2,classification:2,branches:1};
const allocations=Object.fromEntries(WORK_ROLES.map(r=>[r,[]]));
const shrink=Object.fromEntries(WORK_ROLES.map(r=>[r,0]));
const lastSpawn=Object.fromEntries(WORK_ROLES.map(r=>[r,0]));
const stateFile=path.resolve(args.status||'.local-state/workforce-status.json');
let stopping=false;
const stopSignal=()=>{stopping=true;};
process.on('SIGTERM',stopSignal);process.on('SIGINT',stopSignal);
function log(...fields){console.log('WORKFORCE',...fields);}
function spawnAgent(role){
 const worker=role==='branches'?'local/round-runner.mjs':'local/work-role.mjs';
 const params=role==='branches'?
  ['--manifest='+manifestFile,'--out='+outDir,'--watch','--limit=5','--interval-ms=15000','--speed='+speed,'--wait-ms='+Math.max(450,Math.min(waitMs,10000))]:
  ['--role='+role,'--run-id='+runId,'--out='+outDir,'--speed='+speed,'--wait-ms='+waitMs,'--poll-ms=6000'];
 if(args['confirm-adult']===true)params.push('--confirm-adult');
 const child=spawn(process.execPath,[path.resolve(worker),...params],
  {stdio:['ignore','pipe','pipe'],env:process.env,windowsHide:true});
 const record={child,role,startedAt:Date.now(),stopRequested:false};
 allocations[role].push(record);lastSpawn[role]=Date.now();
 const emit=(stream,b)=>{for(const line of b.toString('utf8').trim().split('\n'))if(line)console.log(role+'/'+stream,line.slice(0,900));};
 child.stdout.on('data',b=>emit('out',b));child.stderr.on('data',b=>emit('err',b));
 child.once('error',e=>log('AGENT ERROR',role,e.message));
 child.once('exit',(code,signal)=>{
  const idx=allocations[role].indexOf(record);
  if(idx>=0)allocations[role].splice(idx,1);
  log('AGENT EXIT',role,code,signal);
 });
 log('AGENT START',role,'pid='+child.pid);return record;
}
function requestStop(record){
 if(record.stopRequested)return;
 record.stopRequested=true;
 // The child completes any currently leased job before honoring SIGTERM.
 if(record.child.exitCode===null)record.child.kill('SIGTERM');
 log('AGENT STOP REQUEST',record.role,'pid='+record.child.pid);
}
async function seedTickets(){
 // Operator-approved explicit games. New providers can be added through
 // sources without changing this scheduler or its D1 schema.
 const catalog=manifest.games.filter(g=>g?.enabled!==false&&g?.id&&g?.provider&&g?.url);
 let n=0;
 for(let i=0;i<catalog.length;i+=20){
  const jobs=catalog.slice(i,i+20).map(g=>({role:'catalog',provider:safeId(g.provider),
   subject:safeId(g.id),priority:15,payload:{game:{provider:g.provider,id:g.id,url:g.url}}}));
  n+=(await cloud.enqueueWork(runId,jobs)).inserted;
 }
 return n;
}
async function seedDiscovery(){
 const bucket=Math.floor(Date.now()/(discoveryEveryMinutes*60000));
 const approved=[];
 for(const source of sources){
  if(source?.enabled!==true||source.approved!==true)continue;
  validateDiscoverySource(source);
  const id=discoveryTicketSubject(source.id,bucket);
  approved.push({role:'discovery',provider:source.provider,subject:safeId(id),priority:5,
   payload:{source}});
 }
 let n=0;
 for(let i=0;i<approved.length;i+=20)n+=(await cloud.enqueueWork(runId,approved.slice(i,i+20))).inserted;
 return n;
}
async function reconcile(target){
 for(const role of WORK_ROLES){
  const live=allocations[role].filter(x=>!x.stopRequested&&x.child.exitCode===null);
  const wanted=target.roles[role];
  if(live.length>wanted)shrink[role]++;else shrink[role]=0;
  if(shrink[role]>=2){
   // Keep a one-minute dwell to reduce browser launch churn.
   for(const entry of live.slice(wanted).reverse())if(Date.now()-entry.startedAt>=60000)requestStop(entry);
  }
  if(live.length<wanted&&Date.now()-lastSpawn[role]>3000){
   for(let j=live.length;j<wanted;j++)spawnAgent(role);
  }
 }
}
function workerSummary(){return Object.fromEntries(WORK_ROLES.map(role=>[
 role,allocations[role].filter(x=>x.child.exitCode===null).map(x=>({pid:x.child.pid,stopping:x.stopRequested}))
]));}
async function pulse(){
 const stats=await cloud.workStats(runId);
 const target=planWorkforce(stats,{maxWorkers,browserWorkers,structuredAuto:args['manual-classification']!==true});
 await reconcile(target);
 // The branch role is an already-existing safe single-process executor.
 for(const a of allocations.branches)if(!a.stopRequested&&a.child.exitCode===null)
  await cloud.agentHeartbeat(runId,'branch-'+a.child.pid,'branches','local').catch(e=>log('AGENT HEARTBEAT ERROR',e.message));
 const status={runId,updatedAt:new Date().toISOString(),target:target.roles,
  demand:target.demand,workers:workerSummary(),queue:stats.jobs,captures:stats.captures,
  visualReviewBacklog:target.visualReviewBacklog,needsReview:target.blockedCaptures};
 await writeAtomic(stateFile,status);
 log('ALLOCATION',JSON.stringify({target:target.roles,pending:stats.captures,work:stats.jobs}));
}
try{
 await fs.mkdir(outDir,{recursive:true});
 // Fail fast if the remote 0003 migration has not been applied.
 const initial=await cloud.workStats(runId);
 log('D1 READY',initial.runId);
 const seeded=await seedTickets();
 const seeds=await seedDiscovery();
 log('SEEDED',{catalog:seeded,discovery:seeds});
 do{
  if(await updateDrainRequested()){stopping=true;break;}
  try{
   await seedDiscovery();await pulse();
  }catch(e){log('POLL ERROR',e.message);}
  if(!stopping)await sleep(interval);
 }while(!stopping);
}finally{
 if(await updateDrainRequested()){
  // During an upgrade child agents and the branch runner exit cooperatively
  // after their current task. Never kill an in-flight reviewed DEMO click.
  log('DRAIN WAIT: workers finishing current jobs');
  while(Object.values(allocations).some(xs=>xs.some(x=>x.child.exitCode===null)))await sleep(500);
 }else{
  for(const role of WORK_ROLES)for(const a of allocations[role])requestStop(a);
  const deadline=Date.now()+60000;
  while(Date.now()<deadline&&Object.values(allocations).some(xs=>xs.some(x=>x.child.exitCode===null)))await sleep(350);
 }
 log('STOPPED');
 process.off('SIGINT',stopSignal);process.off('SIGTERM',stopSignal);
}
