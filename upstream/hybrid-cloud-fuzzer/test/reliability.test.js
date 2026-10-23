import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {inferMode} from '../src/candidates.js';
import worker from '../src/worker.js';

const migration=fs.readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8')+'\n'+fs.readFileSync(new URL('../migrations/0002_action_traces.sql',import.meta.url),'utf8');
const image=new Uint8Array([255,216,1,2,3,255,217]);
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec(migration);
  let failHistory=false;
  const DB={
    prepare(query){
      const stmt=db.prepare(query);
      return {bind(...args){return {query,args,first:async()=>stmt.get(...args)??null,run:async()=>({meta:stmt.run(...args)}),all:async()=>({results:stmt.all(...args)})};}};
    },
    async batch(statements){
      db.exec('BEGIN IMMEDIATE');
      try{
        const ret=[];
        for(const {query,args} of statements){
          if(failHistory&&query.includes('decision_history'))throw Error('history unavailable');
          ret.push({meta:db.prepare(query).run(...args)});
        }
        db.exec('COMMIT');return ret;
      }catch(e){db.exec('ROLLBACK');throw e;}
    }
  };
  const images=new Map();
  const IMAGES={put:async(key,bytes)=>images.set(key,bytes.slice(0)),get:async key=>images.has(key)?{arrayBuffer:async()=>images.get(key).slice(0),body:new Blob([images.get(key)]).stream()}:null};
  return {env:{DB,IMAGES,INGEST_TOKEN:'ingest',REVIEW_TOKEN:'review',MCP_TOKEN:'mcp'},sql:db,images,
    failHistory:()=>{failHistory=true;},restoreHistory:()=>{failHistory=false;},close:()=>db.close()};
}
const base={runId:'demo-run',provider:'belatra',gameId:'canvas-a',shotId:'base',state:'BASE',mode:'visual',adapter:'unknown',candidates:[]};
async function ingest(f,data=base){const form=new FormData();form.set('metadata',JSON.stringify(data));form.set('image',new Blob([image],{type:'image/jpeg'}),'demo.jpg');return worker.fetch(new Request('https://unit.test/v1/items',{method:'POST',headers:{Authorization:'Bearer ingest'},body:form}),f.env);}
async function post(f,path,body,token='review'){const res=await worker.fetch(new Request('https://unit.test'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),f.env);return {status:res.status,data:await res.json()};}
async function rpc(f,tool,args){return post(f,'/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:args}},'mcp');}

test('history persistence is transactional: failed history write cannot lose a classified action',async()=>{
 const f=fixture();try{
   assert.equal((await ingest(f)).status,201);
   const {data:{item}}=await post(f,'/v1/claim',{});
   const payload={id:item.id,leaseId:item.leaseId,revision:item.revision,sourceSha256:item.sourceSha256,status:'classified',reviewer:'gpt',marks:[{x:0.2,y:0.3,kind:'buy',label:'Buy'}]};
   f.failHistory();const broken=await post(f,'/v1/save',payload);assert.equal(broken.status,500);
   assert.equal(f.sql.prepare('SELECT status FROM items WHERE id=?').get(item.id).status,'leased');
   assert.equal(f.sql.prepare('SELECT count(*) AS n FROM decision_history').get().n,0);
   f.restoreHistory();const ok=await post(f,'/v1/save',payload);assert.equal(ok.status,200);
   assert.equal(f.sql.prepare('SELECT count(*) AS n FROM decision_history').get().n,1);
 }finally{f.close()}
});

test('decision feed includes only the latest revision for the currently classified item',async()=>{
 const f=fixture();try{
   await ingest(f);const {data:{item}}=await post(f,'/v1/claim',{});
   const payload={id:item.id,leaseId:item.leaseId,revision:item.revision,sourceSha256:item.sourceSha256,status:'classified',reviewer:'gpt',marks:[]};
   assert.equal((await post(f,'/v1/save',payload)).status,200);
   // A historic record can exist with the same image hash; only the current revision is executable.
   f.sql.prepare('INSERT INTO decision_history(item_id,source_sha256,revision,reviewer,status,decisions_json) VALUES(?,?,?,?,?,?)')
     .run(item.id,item.sourceSha256,99,'test','classified',JSON.stringify({allMarks:[{x:0.7,y:0.3,kind:'buy',label:'obsolete'}]}));
   const res=await worker.fetch(new Request('https://unit.test/v1/decisions',{headers:{Authorization:'Bearer review'}}),f.env);
   const feed=await res.json();assert.equal(feed.items.length,1);assert.equal(feed.items[0].decisions.allMarks.length,0);
 }finally{f.close()}
});

test('opaque unknown-state canvas uses image fallback even with one plausible DOM button',()=>{
 const candidates=[{id:'c0',label:'Buy Feature',path:'button#buy',source:'dom',confidence:0.85,rect:{x:0.1,y:0.2,w:0.2,h:0.1}}];
 assert.equal(inferMode({state:'UNKNOWN',candidates,opaqueCanvas:true}),'hybrid');
 assert.equal(inferMode({state:'BASE',candidates,opaqueCanvas:true}),'structured');
 assert.equal(inferMode({state:'UNKNOWN',candidates:[],opaqueCanvas:true}),'visual');
});

test('structured task with opt-in R2 image omits pixels from next_item but get_item can request the JPEG',async()=>{
 const f=fixture();try{
   const structured={...base,mode:'structured',adapter:'known-dom',candidates:[{id:'c0',label:'Buy',source:'dom',confidence:.93,rect:{x:.1,y:.2,w:.2,h:.1}}]};
   const response=await ingest(f,structured);assert.equal(response.status,201);
   const next=await rpc(f,'next_item',{});assert.equal(next.data.result.content.length,1);
   const item=JSON.parse(next.data.result.content[0].text).item;
   assert.equal(item.hasImage,true);
   const detail=await rpc(f,'get_item',{id:item.id,leaseId:item.leaseId,includeImage:true});
   assert.equal(detail.data.result.content.length,2);
   assert.equal(detail.data.result.content[1].mimeType,'image/jpeg');
 }finally{f.close()}
});

test('save_and_next commits selections and claims another provider capture in one MCP call',async()=>{
 const f=fixture();try{
   await ingest(f);
   const second={...base,gameId:'canvas-b'};await ingest(f,second);
   const first=await rpc(f,'next_item',{runId:'demo-run'});
   const c=JSON.parse(first.data.result.content[0].text).item;
   const result=await rpc(f,'save_and_next',{id:c.id,leaseId:c.leaseId,revision:c.revision,sourceSha256:c.sourceSha256,
     reviewer:'gpt',status:'classified',marks:[{x:0.3,y:0.4,kind:'buy',label:'Free spins'}],runId:'demo-run'});
   const text=JSON.parse(result.data.result.content[0].text);
   assert.equal(text.saved,true);assert.equal(text.savedItem.status,'classified');
   assert.equal(text.next.item.gameId,'canvas-b');assert.equal(result.data.result.content[1].mimeType,'image/jpeg');
   const empty=await rpc(f,'save_and_next',{id:text.next.item.id,leaseId:text.next.item.leaseId,revision:text.next.item.revision,
     sourceSha256:text.next.item.sourceSha256,reviewer:'gpt',status:'classified',marks:[]});
   assert.equal(JSON.parse(empty.data.result.content[0].text).next.empty,true);
   assert.equal(f.sql.prepare('SELECT count(*) AS n FROM decision_history').get().n,2);
 }finally{f.close()}
});
