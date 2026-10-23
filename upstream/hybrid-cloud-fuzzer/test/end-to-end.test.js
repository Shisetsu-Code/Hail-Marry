import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
import {runImport} from '../local/import-fuzzer.mjs';
const sql=readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../migrations/0002_action_traces.sql',import.meta.url),'utf8');
function mockWorker(){
 const db=new DatabaseSync(':memory:');db.exec(sql);
 const DB={prepare(query){const st=db.prepare(query);const bind=(args)=>({query,args,first:async()=>st.get(...args)??null,run:async()=>({meta:st.run(...args)}),all:async()=>({results:st.all(...args)})});return {...bind([]),bind:(...args)=>bind(args)};},async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=statements.map(({query,args})=>({meta:db.prepare(query).run(...args)}));db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const images=new Map(),IMAGES={put:async(k,b)=>images.set(k,b.slice(0)),get:async k=>images.has(k)?{arrayBuffer:async()=>images.get(k).slice(0),body:new Blob([images.get(k)]).stream()}:null};
 const env={DB,IMAGES,INGEST_TOKEN:'e2e-ingest',REVIEW_TOKEN:'e2e-review',MCP_TOKEN:'e2e-mcp'};
 const request=async(url,init={})=>worker.fetch(new Request(url,{...init,headers:{...(init.headers||{})}}),env);
 return {db,request,images,close:()=>db.close()};
}
const jpeg=Buffer.from([255,216,3,4,5,255,217]);
test('Fuzzer-Manual import -> HTTP ingest -> MCP control classification -> D1 decisions feed',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'hybrid-e2e-')),old=path.join(temp,'old'),out=path.join(temp,'outbox');
 const f=mockWorker();try{
   for(const d of ['shots','metadata'])await fs.mkdir(path.join(old,d),{recursive:true});
   await fs.writeFile(path.join(old,'manifest.json'),JSON.stringify({runId:'demo-20261019',entries:{alpha:{slug:'alpha',taskId:8,status:'ready',state:'BASE',image:'shots/alpha.jpg',metadata:'metadata/alpha.json'}}}));
   await fs.writeFile(path.join(old,'shots/alpha.jpg'),jpeg);
   await fs.writeFile(path.join(old,'metadata/alpha.json'),JSON.stringify({viewport:{width:1024,height:576},controls:[{path:'Game/Main/FeaturePurchase/Buy',texts:['BUY FEATURE'],hit:{x:.2,y:.3,w:.1,h:.1}}]}));
   assert.equal((await runImport({sourceDir:old,outDir:out,log:()=>{}})).added,1);
   process.env.HYBRID_FUZZER_URL='https://worker.test';process.env.HYBRID_INGEST_TOKEN='e2e-ingest';
   const {syncOnce}=await import('../local/sync.mjs?e2e'+Date.now());
   const result=await syncOnce({sourceDir:out,log:()=>{},fetcher:f.request});assert.equal(result.saved,1);
   const rpc=async(name,args)=>{const res=await f.request('https://worker.test/mcp',{method:'POST',headers:{Authorization:'Bearer e2e-mcp','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await res.json()).result;};
   const response=await rpc('next_item',{runId:'demo-20261019'});
   assert.equal(response.content.length,1);const item=JSON.parse(response.content[0].text).item;
   assert.equal(item.mode,'structured');assert.equal(item.candidates.length,1);
   const saved=await rpc('save_and_next',{id:item.id,leaseId:item.leaseId,revision:item.revision,sourceSha256:item.sourceSha256,
     reviewer:'gpt',status:'classified',selections:[{candidateId:'c0',kind:'buy'}]});
   const data=JSON.parse(saved.content[0].text);
   assert.equal(data.saved,true);assert.equal(data.next.empty,true);
   const feed=await f.request('https://worker.test/v1/decisions',{headers:{Authorization:'Bearer e2e-review'}});
   const body=await feed.json();assert.equal(body.items.length,1);assert.equal(body.items[0].decisions.allMarks[0].kind,'buy');
   const health=await f.request('https://worker.test/health');assert.equal((await health.json()).ok,true);
   assert.equal((await syncOnce({sourceDir:out,log:()=>{},fetcher:f.request})).skipped,1);
 }finally{f.close();await fs.rm(temp,{recursive:true,force:true});}
});
