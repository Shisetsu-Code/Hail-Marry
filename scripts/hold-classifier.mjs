import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { processAlive, stopProcesses } from './start-classifier.mjs';

export async function holdClassifier({root=process.cwd(),stopOnly=false,fetchImpl=fetch,intervalMs=15000}={}) {
  let runtime;
  try { runtime=JSON.parse(await readFile(path.join(root,'artifacts/classifier-runtime.json'),'utf8')); }
  catch(error) { if(stopOnly&&error.code==='ENOENT') return; throw new Error('Classifier runtime metadata is unavailable'); }
  if(stopOnly) { await stopProcesses(runtime); return; }
  if(runtime.schemaVersion!==1||!Array.isArray(runtime.processes)||runtime.processes.length!==2||!Number.isInteger(runtime.port)||runtime.port<1||runtime.port>65535) throw new Error('Classifier runtime metadata is invalid');
  const until=Date.parse(runtime.expiresAt);
  if(!Number.isFinite(until)||until>Date.now()+180*60000+5000) throw new Error('Classifier session expiration is invalid');
  const controller=new AbortController(), interrupt=()=>controller.abort();
  process.once('SIGTERM',interrupt); process.once('SIGINT',interrupt);
  let failures=0;
  try {
    while(Date.now()<until) {
      controller.signal.throwIfAborted();
      for(const record of runtime.processes) if(!await processAlive(record)) throw new Error(`Classifier ${record.name==='server'?'server':'tunnel'} stopped`);
      try {
        const response=await fetchImpl(`http://127.0.0.1:${runtime.port}/health`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])});
        await response.body?.cancel(); if(!response.ok) throw new Error('Unhealthy'); failures=0;
      } catch { if(++failures>=3) throw new Error('Classifier health failed repeatedly'); }
      await delay(Math.min(intervalMs,Math.max(1,until-Date.now())),undefined,{signal:controller.signal});
    }
  } finally {
    process.removeListener('SIGTERM',interrupt); process.removeListener('SIGINT',interrupt);
    await stopProcesses(runtime);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { await holdClassifier({stopOnly:process.argv.slice(2).includes('--stop')}); }
  catch { console.error('Classifier session stopped or failed; inspect the classifier logs.'); process.exitCode=1; }
}
