import fs from 'node:fs/promises';
import path from 'node:path';
import {mergeProgress} from './progress.js';
import {readJSON,writeAtomic} from './utils.js';
const settings=await readJSON('.local-state/collector-control.json',null);
if(!settings)throw Error('Collector configuration missing');
const manifest=JSON.parse(await fs.readFile(settings.manifest,'utf8'));
const base=new URL(settings.workerUrl);
if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error('Invalid Worker URL');
const res=await fetch(new URL('/v1/progress?'+new URLSearchParams({runId:manifest.runId}),base),{
 headers:{Authorization:`Bearer ${process.env.HYBRID_REVIEW_TOKEN}`},signal:AbortSignal.timeout(20000)});
if(!res.ok)throw Error('Cloudflare progress HTTP '+res.status);
const cloud=await res.json();
const journal=await readJSON(path.join(settings.outbox,'.round-journal.json'),{entries:{}});
await writeAtomic('.local-state/collector-progress.json',mergeProgress(cloud,manifest,journal));
