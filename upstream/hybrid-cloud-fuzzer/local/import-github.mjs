#!/usr/bin/env node
// Import public GitHub catalog snapshots to the hybrid outbox without reloading demos.
// Network: GitHub public raw files -> local outbox; local/sync.mjs -> Cloudflare R2/D1.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {cli,safeId,writeAtomic} from './utils.js';
import {convert} from './import-fuzzer.mjs';

function safeBranch(input){if(!/^[\w.-]+(?:\/[\w.-]+)*$/.test(input)||input.includes('..'))throw Error('Invalid branch');return input;}
function safeFile(name,prefix,suffix){
  if(typeof name!=='string'||!name.startsWith(prefix)||!name.endsWith(suffix))throw Error('Unsafe snapshot path');
  const s=name.slice(prefix.length,-suffix.length);
  if(!/^[a-z0-9-]{1,100}$/.test(s))throw Error('Unsafe screenshot slug');
  return s;
}
export async function importGithub({
  repo='Shisetsu-Code/Fuzzer-Manual',branch='catalog-snapshots',runId='pragmatic-20261019',
  outDir='outbox',limit=Infinity,concurrency=4,fetcher=fetch,log=console.log,retries=3,
  token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN||''
}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error('Invalid repository');
  safeBranch(branch);safeId(runId,'runId');
  if((!Number.isSafeInteger(limit)&&limit!==Infinity)||limit<0)throw Error('Invalid limit');
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw Error('concurrency 1..8');
  if(!Number.isSafeInteger(retries)||retries<1||retries>5)throw Error('retries 1..5');
  const source=`https://raw.githubusercontent.com/${repo}/${branch}/runs/${runId}`;
  async function get(rel,{binary=false}={}){
    const url=`${source}/${rel}`;
    for(let n=0;n<retries;n++){
      let response;
      try{response=await fetcher(url,{headers:token?{Authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(30000)});}
      catch(e){if(n===retries-1)throw e;await delay((2**n)*250);continue;}
      if(response.status===404)return null;
      if(!response.ok){if((response.status===429||response.status>=500)&&n<retries-1){await delay((2**n)*250);continue;}throw Error(`GitHub HTTP ${response.status}: ${rel}`);}
      const bytes=new Uint8Array(await response.arrayBuffer());
      if(bytes.byteLength>(binary?8*1024*1024:2*1024*1024))throw Error(`GitHub item too large: ${rel}`);
      return binary?bytes:JSON.parse(new TextDecoder().decode(bytes));
    }
  }
  const manifest=await get('manifest.json');
  if(!manifest?.entries||manifest.runId!==runId)throw Error('Missing/mismatched GitHub manifest');
  await fs.mkdir(outDir,{recursive:true});
  const jobs=Object.values(manifest.entries).filter(row=>['ready','review'].includes(row.status)&&row.image&&row.metadata).slice(0,limit);
  let next=0,added=0,skipped=0,missing=0,failed=0;
  await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{
    while(next<jobs.length){
      const row=jobs[next++];
      try{
        safeId(row.slug,'slug');
        if(!Number.isSafeInteger(row.taskId)||row.taskId<1)throw Error('invalid taskId');
        const imageSlug=safeFile(row.image,row.status==='ready'?'shots/':'review/','.jpg');
        const metadataSlug=safeFile(row.metadata,'metadata/','.json');
        if(imageSlug!==row.slug||metadataSlug!==row.slug)throw Error('Image/metadata slug mismatch');
        const key=`${runId}__pragmatic__${row.slug}__task-${row.taskId}`;
        const metaPath=path.join(outDir,key+'.json'),imgPath=path.join(outDir,key+'.jpg');
        if(await fs.stat(metaPath).catch(()=>null)&&await fs.stat(imgPath).catch(()=>null)){skipped++;continue;}
        const [metadata,bytes]=await Promise.all([get(row.metadata),get(row.image,{binary:true})]);
        if(!metadata||!bytes){missing++;continue;}
        if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)throw Error('Invalid JPEG');
        const item=convert(row,metadata,runId);
        item.metadata.originalGithubUrl=`https://github.com/${repo}/blob/${branch}/runs/${runId}/${row.image}`;
        item.metadata.originalImageSha256=createHash('sha256').update(bytes).digest('hex');
        const tmp=imgPath+'.tmp';await fs.writeFile(tmp,bytes);await fs.rename(tmp,imgPath);
        await writeAtomic(metaPath,item);
        added++;log(`IMPORTED ${row.slug} ${item.mode}`);
      }catch(e){failed++;console.error(`ERROR ${row.slug}: ${e.message}`);}
    }
  }));
  log(`GITHUB IMPORT added=${added} skipped=${skipped} missing=${missing} failed=${failed}`);
  return {added,skipped,missing,failed};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const opts=cli(process.argv.slice(2));
  await importGithub({repo:opts.repo||'Shisetsu-Code/Fuzzer-Manual',branch:opts.branch||'catalog-snapshots',
    runId:opts.runId||'pragmatic-20261019',outDir:opts.out||'outbox',
    limit:opts.limit?Number(opts.limit):Infinity,concurrency:opts.concurrency?Number(opts.concurrency):4});
}
