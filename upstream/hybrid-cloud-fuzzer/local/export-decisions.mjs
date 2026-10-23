#!/usr/bin/env node
// Optional download of classified actions, compatible with a separate local executor.
import path from 'node:path';
import {cli,readJSON,writeAtomic} from './utils.js';
const args=cli(process.argv.slice(2)),url=(args.url||process.env.HYBRID_FUZZER_URL||'').replace(/\/$/,'');
const token=process.env.HYBRID_REVIEW_TOKEN;
if(!url.startsWith('https://')||!token)throw Error('Set HYBRID_FUZZER_URL and HYBRID_REVIEW_TOKEN');
const file=path.resolve(args.out||'classified-actions.json'),old=await readJSON(file,{after:0,items:[]});
let after=old.after;const items=old.items;
for(;;){const p=new URL(url+'/v1/decisions');p.searchParams.set('after',String(after));if(args.runId)p.searchParams.set('runId',args.runId);
 const r=await fetch(p,{headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw Error(`HTTP ${r.status}`);
 const data=await r.json();items.push(...data.items);after=data.nextAfter;
 await writeAtomic(file,{after,items});if(data.items.length<50)break;
}
console.log(`DECISIONS total=${items.length} after=${after} saved=${file}`);
