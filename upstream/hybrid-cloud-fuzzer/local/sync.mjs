#!/usr/bin/env node
// Transfer hybrid outbox items to Cloudflare Worker. Binary JPEG only for visual/hybrid.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {cli,readJSON,writeAtomic} from './utils.js';
import {updateDrainRequested} from './update-drain.js';
const args=cli(process.argv.slice(2));
const source=path.resolve(args.out||'outbox');
const endpoint=(args.url||process.env.HYBRID_FUZZER_URL||'').replace(/\/$/,'');
const token=process.env.HYBRID_INGEST_TOKEN||'';
if(!/^https:\/\//.test(endpoint)||!token)throw Error('Set HYBRID_FUZZER_URL and HYBRID_INGEST_TOKEN; do not commit tokens');
const interval=Number(args['interval-ms']||10000),concurrency=Number(args.concurrency||2);
if(!Number.isInteger(interval)||interval<2000||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('invalid interval/concurrency');
const ledgerFile=path.join(source,'.synced.json');
async function submit(file,item){
  const metadata=JSON.stringify(item);
  if(item.mode==='structured')return {headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:metadata};
  const jpg=file.replace(/\.json$/i,'.jpg'),image=await fs.readFile(jpg);
  if(image.byteLength>8*1024*1024)throw Error('JPEG too large');
  const form=new FormData();form.set('metadata',metadata);form.set('image',new Blob([image],{type:'image/jpeg'}),path.basename(jpg));
  return {headers:{Authorization:`Bearer ${token}`},body:form};
}
export async function syncOnce({sourceDir=source,fetcher=fetch,log=console.log}={}){
  const ledger=await readJSON(path.join(sourceDir,'.synced.json'),{});
  const listing=(await fs.readdir(sourceDir)).filter(f=>f.endsWith('.json')&&!f.startsWith('.')).sort();
  let idx=0,saved=0,skipped=0,failed=0;let ledgerWrites=Promise.resolve();
  const markUploaded=(name,hash)=>{ledgerWrites=ledgerWrites.then(async()=>{ledger[name]=hash;await writeAtomic(path.join(sourceDir,'.synced.json'),ledger);});return ledgerWrites;};
  await Promise.all(Array.from({length:Math.min(concurrency,listing.length)},async()=>{
    while(idx<listing.length){const name=listing[idx++],file=path.join(sourceDir,name);
      try{
        const contents=await fs.readFile(file),item=JSON.parse(contents.toString());
        if(!item.runId||!item.gameId){skipped++;continue;}
        const jpg=name.replace(/\.json$/,'.jpg');
        const img=item.mode==='structured'?'':await fs.readFile(path.join(sourceDir,jpg));
        const hash=createHash('sha256').update(contents).update(img).digest('hex');
        if(ledger[name]===hash){skipped++;continue;}
        const req=await submit(file,item);let error;
        for(let attempt=0;attempt<4;attempt++){
          try{const res=await fetcher(endpoint+'/v1/items',{method:'POST',...req,signal:AbortSignal.timeout(40000)});
            const body=await res.json().catch(()=>({}));
            if(!res.ok){const e=Error(`HTTP ${res.status}: ${body.error||'upload error'}`);if(![408,429,500,502,503,504].includes(res.status))e.permanent=true;throw e;}
            if(body.item?.gameId!==item.gameId)throw Error('server game identity mismatch');
            await markUploaded(name,hash);saved++;error=null;log(`UPLOADED ${item.provider}/${item.gameId} ${item.mode}`);break;
          }catch(e){error=e;if(e.permanent||attempt===3)break;await sleep(500*(2**attempt));}
        }
        if(error)throw error;
      }catch(e){failed++;console.error(`ERROR ${name} ${e.message}`);}
    }
  }));
  log(`SYNC uploaded=${saved} skipped=${skipped} failed=${failed}`);return {saved,skipped,failed};
}
if(process.argv[1]?.endsWith('sync.mjs')){do{if(await updateDrainRequested())break;await syncOnce();if(args.watch)await sleep(interval);}while(args.watch);}
