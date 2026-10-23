import { spawn } from 'node:child_process';
import { open, mkdir, readFile, writeFile, rename, appendFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function processIdentity(pid) {
  if(!Number.isInteger(pid)||pid<2) return null;
  try {
    const stat=await readFile(`/proc/${pid}/stat`,'utf8'), fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    return {pid,groupId:Number(fields[2]),sessionId:Number(fields[3]),startTime:fields[19],state:fields[0]};
  } catch { return null; }
}
export async function processAlive(record) {
  if(!record||!/^\d+$/.test(record.startTime||'')||record.groupId!==record.pid) return false;
  const current=await processIdentity(record.pid);
  return Boolean(current&&current.startTime===record.startTime&&current.groupId===record.groupId&&current.state!=='Z');
}
async function processGroupAlive(record) {
  if(!record||!/^\d+$/.test(record.startTime||'')||record.groupId!==record.pid||record.sessionId!==record.pid) return false;
  const leader=await processIdentity(record.pid);
  if(leader&&leader.startTime!==record.startTime) return false;
  if(leader&&leader.state!=='Z') return true;
  // A process-group ID stays reserved while descendants remain, even after its
  // original leader exits. Find those members rather than trusting a reused PID.
  for(const name of await readdir('/proc')) {
    if(!/^\d+$/.test(name)) continue;
    const member=await processIdentity(Number(name));
    if(member&&member.groupId===record.pid&&member.sessionId===record.pid&&member.state!=='Z') return true;
  }
  return false;
}
async function signalProcess(record,signal,{group=false}={}) {
  if(!await (group?processGroupAlive(record):processAlive(record))) return;
  try { process.kill(group?-record.pid:record.pid,signal); } catch(error) { if(error.code!=='ESRCH') throw new Error('Unable to stop a classifier process'); }
}
export async function stopProcesses(runtime,{graceMs=20000}={}) {
  const records=Array.isArray(runtime?.processes)?runtime.processes:[];
  // Let the server checkpoint and close Chromium before killing its process group.
  await Promise.all(records.map(record=>signalProcess(record,'SIGTERM',{group:record.name==='tunnel'})));
  const deadline=Date.now()+graceMs;
  while(Date.now()<deadline&&(await Promise.all(records.map(processAlive))).some(Boolean)) await delay(Math.min(100,Math.max(1,deadline-Date.now())));
  await Promise.all(records.map(record=>signalProcess(record,'SIGKILL',{group:true})));
  const stopped=Date.now()+1000;
  while(Date.now()<stopped&&(await Promise.all(records.map(processGroupAlive))).some(Boolean)) await delay(20);
}
export async function writeRuntime(filename,runtime) {
  const temporary=filename+'.tmp'; await writeFile(temporary,JSON.stringify(runtime,null,2)+'\n',{mode:0o600}); await rename(temporary,filename);
}
async function startProcess(command,args,{root,env,log,name}) {
  let child;
  try { child=spawn(command,args,{cwd:root,detached:true,stdio:['ignore',log.fd,log.fd],env}); }
  catch { throw new Error(`Classifier ${name} could not start`); }
  // Keep an error listener for the entire child lifetime; failed exec is asynchronous.
  let failed=false; child.on('error',()=>{failed=true;});
  await new Promise((resolve,reject)=>{
    child.once('spawn',resolve); child.once('error',()=>reject(new Error(`Classifier ${name} could not start`)));
  });
  const identity=await processIdentity(child.pid);
  if(failed||!identity||identity.groupId!==child.pid) throw new Error(`Classifier ${name} exited during startup`);
  child.unref(); return {child,record:{name,...identity}};
}
async function waitFor(check,{label,timeoutMs,signal,processes}) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    signal.throwIfAborted();
    for(const record of processes) if(!await processAlive(record)) throw new Error(`Classifier ${record.name} exited during startup`);
    if(await check()) return;
    await delay(Math.min(1000,Math.max(1,deadline-Date.now())),undefined,{signal});
  }
  throw new Error(label);
}

export async function startClassifier({root=process.cwd(),env=process.env,fetchImpl=fetch,localTimeoutMs=120000,tunnelTimeoutMs=90000,publicTimeoutMs=90000}={}) {
  const config=JSON.parse(await readFile(path.join(root,'config/classifier-session.json'),'utf8'));
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(config.runId||'')||!Number.isInteger(config.durationMinutes)||config.durationMinutes<1||config.durationMinutes>180) throw new Error('Invalid classifier session configuration');
  if(!env.GITHUB_TOKEN||!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(env.GITHUB_REPOSITORY||'')) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const port=Number(env.PORT||8767);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid classifier server port');
  const artifacts=path.join(root,'artifacts'); await mkdir(artifacts,{recursive:true});
  const runtimeFile=path.join(artifacts,'classifier-runtime.json');
  // A restart cleans up only matching process identities from this workspace.
  try { await stopProcesses(JSON.parse(await readFile(runtimeFile,'utf8'))); } catch(error) { if(error.code!=='ENOENT') throw error; }
  const runtime={schemaVersion:1,runId:config.runId,port,processes:[],serverPid:null,tunnelPid:null};
  const controller=new AbortController(), interrupt=()=>controller.abort(new Error('Classifier startup interrupted'));
  process.once('SIGTERM',interrupt); process.once('SIGINT',interrupt);
  let serverLog,tunnelLog,success=false;
  try {
    serverLog=await open(path.join(artifacts,'classifier-server.log'),'w',0o600);
    tunnelLog=await open(path.join(artifacts,'classifier-tunnel.log'),'w',0o600);
    const server=await startProcess(process.execPath,['classifier/main.mjs'],{root,env,log:serverLog,name:'server'});
    runtime.processes.push(server.record); runtime.serverPid=server.child.pid; await writeRuntime(runtimeFile,runtime);
    const health=async url=>{
      try {
        const response=await fetchImpl(url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(4000)])});
        await response.body?.cancel(); return response.ok;
      } catch { return false; }
    };
    await waitFor(()=>health(`http://127.0.0.1:${port}/health`),{label:'Classifier server did not become healthy',timeoutMs:localTimeoutMs,signal:controller.signal,processes:runtime.processes});
    const tunnelEnv=Object.fromEntries(['PATH','HOME','TMPDIR','RUNNER_TRACKING_ID'].filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));
    const tunnel=await startProcess(env.CLOUDFLARED_PATH||'cloudflared',['tunnel','--no-autoupdate','--protocol','http2','--url',`http://127.0.0.1:${port}`],{root,env:tunnelEnv,log:tunnelLog,name:'tunnel'});
    runtime.processes.push(tunnel.record); runtime.tunnelPid=tunnel.child.pid; await writeRuntime(runtimeFile,runtime);
    let url;
    await waitFor(async()=>{
      const log=await readFile(path.join(artifacts,'classifier-tunnel.log'),'utf8');
      url=log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0]; return Boolean(url);
    },{label:'Temporary tunnel URL unavailable',timeoutMs:tunnelTimeoutMs,signal:controller.signal,processes:runtime.processes});
    await waitFor(()=>health(url+'/health'),{label:'Public classifier health check failed',timeoutMs:publicTimeoutMs,signal:controller.signal,processes:runtime.processes});
    const startedAt=new Date(), session={schemaVersion:1,runId:config.runId,url,startedAt:startedAt.toISOString(),
      expiresAt:new Date(startedAt.getTime()+config.durationMinutes*60000).toISOString(),durationMinutes:config.durationMinutes,
      repository:env.GITHUB_REPOSITORY,workflowRun:env.GITHUB_RUN_ID?`https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`:null,
      dataBranch:config.dataBranch||'classifier-data',authentication:'bearer-key-required'};
    await writeFile(path.join(artifacts,'classifier-session.json'),JSON.stringify(session,null,2)+'\n',{mode:0o600});
    runtime.expiresAt=session.expiresAt; await writeRuntime(runtimeFile,runtime);
    if(env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,`## Clasificador iniciado\n\n[Interfaz](${url}) · requiere tu clave de acceso.\n\nModos **1–5** y **Q**. Disponible hasta **${session.expiresAt}** (UTC), durante ${config.durationMinutes} minutos. Rutas guardadas en **${session.dataBranch}**.\n`);
    success=true; return session;
  } finally {
    process.removeListener('SIGTERM',interrupt); process.removeListener('SIGINT',interrupt);
    if(!success) await stopProcesses(runtime);
    await serverLog?.close(); await tunnelLog?.close();
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({type:'classifier-public-ready',...await startClassifier()})); }
  catch { console.error('Classifier startup failed; inspect the classifier logs.'); process.exitCode=1; }
}
