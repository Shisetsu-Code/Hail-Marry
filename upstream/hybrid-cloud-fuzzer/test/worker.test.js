import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/worker.js';
import {inferMode,normalizeCandidates,validateItem,normalizeDecisions} from '../src/candidates.js';
import {storeValidation} from '../src/capture-validation.js';
import {hashHex} from '../src/core.js';
const migration=fs.readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8');
function fixture({withoutTraces=false}={}){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(migration);if(!withoutTraces)sqlite.exec(fs.readFileSync(new URL('../migrations/0002_action_traces.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){const stmt=sqlite.prepare(sql);const bound=args=>({query:sql,args,first:async()=>stmt.get(...args)||null,run:async()=>({meta:stmt.run(...args)}),all:async()=>({results:stmt.all(...args)})});return {...bound([]),bind:(...args)=>bound(args)}},async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=statements.map(({query,args})=>({meta:sqlite.prepare(query).run(...args)}));sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const images=new Map(),IMAGES={put:async(key,data)=>{images.set(key,data instanceof ArrayBuffer?data.slice(0):data);},get:async key=>images.has(key)?{
    arrayBuffer:async()=>typeof images.get(key)==='string'?new TextEncoder().encode(images.get(key)).buffer:images.get(key).slice(0),body:new Blob([images.get(key)]).stream(),text:async()=>String(images.get(key))}:null};
  return {env:{DB,IMAGES,INGEST_TOKEN:'ingest-test',REVIEW_TOKEN:'review-test',MCP_TOKEN:'mcp-test'},images,close:()=>sqlite.close()};
}
const JPEG=new Uint8Array([255,216,1,2,3,4,255,217]);

test('validation previews require review auth and rejected screenshots do not enter the queue',async()=>{
 const f=fixture();try{
  const url='https://worker.example/v1/validation-reports';
  assert.equal((await worker.fetch(new Request(url,{method:'POST'}),f.env)).status,401);
  const form=new FormData();form.set('metadata',JSON.stringify({runId:'validation-a',provider:'sample',gameId:'one',validatorVersion:'1',status:'loading',reasons:['loading-screen']}));form.set('image',new Blob([JPEG],{type:'image/jpeg'}),'comparison.jpg');
  const response=await worker.fetch(new Request(url,{method:'POST',headers:{Authorization:'Bearer ingest-test'},body:form}),f.env);
  assert.equal(response.status,201);const {report}=await response.json();
  assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS n FROM items').first()).n,0);
  const preview='https://worker.example/v1/validation-previews/'+report.id;
  assert.equal((await worker.fetch(new Request(preview),f.env)).status,401);
  assert.equal((await worker.fetch(new Request(preview,{headers:{Authorization:'Bearer review-test'}}),f.env)).status,200);
 }finally{f.close();}
});
test('new GitHub catalogue captures require validation bound to their exact image',async()=>{
 const f=fixture();try{
  const payload=imageItem({runId:'readiness-gate',gameId:'unvalidated'});payload.metadata={source:'github-actions-catalogue'};
  const form=new FormData();form.set('metadata',JSON.stringify(payload));form.set('image',new Blob([JPEG],{type:'image/jpeg'}),'game.jpg');
  const response=await worker.fetch(new Request('https://worker.example/v1/items',{method:'POST',headers:{Authorization:'Bearer ingest-test'},body:form}),f.env);
  assert.equal(response.status,409);assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS n FROM items').first()).n,0);
 }finally{f.close();}
});
test('approved exact-image validation admits a capture and rejects a different JPEG',async()=>{
 const f=fixture();try{
  const payload=imageItem({runId:'validated-input',gameId:'valid'});
  const report=await storeValidation(f.env,{runId:payload.runId,provider:payload.provider,gameId:payload.gameId,status:'ready',reasons:['visible-distinct-instruments'],validatorVersion:'1',sourceImageSha256:await hashHex(JPEG),anchors:[{role:'balance',rect:[.1,.8,.1,.1]},{role:'bet',rect:[.3,.8,.1,.1]}]},JPEG);
  payload.metadata={source:'github-actions-catalogue',captureValidation:{status:'ready',reportId:report.id}};
  const send=async(image)=>{const form=new FormData();form.set('metadata',JSON.stringify(payload));form.set('image',new Blob([image],{type:'image/jpeg'}),'game.jpg');return worker.fetch(new Request('https://worker.example/v1/items',{method:'POST',headers:{Authorization:'Bearer ingest-test'},body:form}),f.env);};
  assert.equal((await send(JPEG)).status,201);
  payload.shotId='different';assert.equal((await send(new Uint8Array([255,216,7,8,255,217]))).status,409);
  assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS n FROM items').first()).n,1);
 }finally{f.close();}
});
test('progress is private, run-scoped and observational',async()=>{
 const f=fixture();
 try{
  await upload(f.env,imageItem({runId:'progress-a',gameId:'alpha'}));
  await upload(f.env,imageItem({runId:'progress-b',gameId:'beta'}));
  const before=await f.env.DB.prepare('SELECT COUNT(*) AS n FROM items').first();
  const url='https://worker.example/v1/progress?runId=progress-a';
  assert.equal((await worker.fetch(new Request(url),f.env)).status,401);
  const res=await worker.fetch(new Request(url,{headers:{Authorization:'Bearer review-test'}}),f.env);
  assert.equal(res.status,200);const report=await res.json();
  assert.deepEqual(report.games.map(g=>g.gameId),['alpha']);
  assert.equal(report.games[0].pending,1);assert.equal(report.games[0].finished,false);
  assert.deepEqual(await f.env.DB.prepare('SELECT COUNT(*) AS n FROM items').first(),before);
 }finally{f.close();}
});
const candidate={id:'c0',label:'BUY FEATURE',source:'runtime',role:'button',confidence:0.93,rect:{x:0.2,y:0.3,w:0.2,h:0.2},path:'GameRoot/BuyFeature/Collider'};
const item=(other={})=>({runId:'test-run',provider:'pragmatic',gameId:'demo-a',shotId:'base',state:'BASE',mode:'structured',adapter:'pragmatic-runtime',candidates:[candidate],metadata:{demo:true},...other});
async function request(env,path,payload,token='review-test'){
  const r=new Request('https://worker.example'+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  return worker.fetch(r,env);
}
async function upload(env,payload=imageItem(),img=JPEG){
  if(!img)return request(env,'/v1/items',payload,'ingest-test');
  const body=new FormData();body.set('metadata',JSON.stringify(payload));body.set('image',new Blob([img],{type:'image/jpeg'}),'demo.jpg');if(payload.replace)body.set('replace','true');
  return worker.fetch(new Request('https://worker.example/v1/items',{method:'POST',headers:{Authorization:'Bearer ingest-test'},body}),env);
}
const imageItem=(other={})=>item({mode:'visual',candidates:[],adapter:'opaque-canvas',...other});
async function get(env,path,token='review-test'){return worker.fetch(new Request('https://worker.example'+path,{headers:{Authorization:`Bearer ${token}`}}),env);}
async function rpc(env,name,arg){const response=await worker.fetch(new Request('https://worker.example/mcp',{method:'POST',headers:{Authorization:'Bearer mcp-test','Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arg}})}),env);return response.json();}

test('candidate normalization, quality and correct decision coordinate mapping',()=>{
  const normalized=normalizeCandidates([candidate]);assert.equal(normalized.length,1);
  assert.equal(inferMode({state:'BASE',candidates:normalized,opaqueCanvas:true}),'structured');
  assert.equal(inferMode({state:'INTRO',candidates:normalized}),'visual');
  assert.equal(inferMode({state:'BASE',candidates:[]}),'visual');
  assert.throws(()=>normalizeCandidates([{...candidate,rect:{x:0.99,y:0,w:0.2,h:0.1}}]),/outside/);
  assert.throws(()=>normalizeCandidates([candidate,candidate]),/duplicate/);
  assert.throws(()=>validateItem(item({mode:'structured',candidates:[]})),/needs candidates/);
  assert.deepEqual(normalizeDecisions({selections:[{candidateId:'c0',kind:'buy'}],marks:[{x:0.8,y:0.9,kind:'pick',label:'second'}]},normalized).allMarks,
    [{x:0.3,y:0.4,kind:'buy',label:'BUY FEATURE'},{x:0.8,y:0.9,kind:'pick',label:'second'}]);
  assert.throws(()=>normalizeDecisions({selections:[{candidateId:'c50',kind:'buy'}]},normalized),/no longer exists/);
});

test('structured-only ingestion: no image, auth, idempotence, lease, save and consume D1 decisions',async()=>{
  const f=fixture();try{
    assert.equal((await get(f.env,'/v1/stats','ingest-test')).status,401);
    const created=await upload(f.env,item(),null);assert.equal(created.status,201);
    const first=(await created.json()).item;assert.equal(first.mode,'structured');assert.equal(first.hasImage,false);assert.equal(f.images.size,0);
    const duplicate=(await (await upload(f.env,item(),null)).json()).item;assert.equal(duplicate.unchanged,true);
    const claim=(await (await request(f.env,'/v1/claim',{})).json()).item;
    assert.equal(claim.status,'leased');assert.equal(claim.revision,1);
    assert.equal((await request(f.env,'/v1/save',{id:claim.id,leaseId:claim.leaseId,revision:claim.revision,sourceSha256:'0'.repeat(64),reviewer:'gpt',status:'classified',selections:[{candidateId:'c0',kind:'buy'}]})).status,409);
    const data={id:claim.id,leaseId:claim.leaseId,revision:claim.revision,sourceSha256:claim.sourceSha256,reviewer:'gpt',status:'classified',selections:[{candidateId:'c0',kind:'buy'}]};
    const saved=await request(f.env,'/v1/save',data);assert.equal(saved.status,200);
    const res=(await saved.json()).item;assert.equal(res.decisions.allMarks[0].x,0.3);
    assert.equal((await request(f.env,'/v1/save',data)).status,409);
    const feed=(await (await get(f.env,'/v1/decisions?after=0&runId=test-run')).json());
    assert.equal(feed.items.length,1);assert.equal(feed.items[0].decisions.allMarks[0].kind,'buy');
    assert.equal((await (await request(f.env,'/v1/claim',{})).json()).item,null);
  }finally{f.close()}
});

test('visual unknown provider stores private JPEG, MCP returns image only for visual mode',async()=>{
  const f=fixture();try{
    const res=await upload(f.env,imageItem({provider:'rubyplay',gameId:'canvas-demo'}));assert.equal(res.status,201);
    const created=(await res.json()).item;assert.equal(created.hasImage,true);assert.equal(f.images.size,1);
    const next=await rpc(f.env,'next_item',{runId:'test-run'});
    const [msg,picture]=next.result.content;const claimed=JSON.parse(msg.text).item;
    assert.equal(claimed.provider,'rubyplay');assert.equal(picture.mimeType,'image/jpeg');assert.deepEqual(new Uint8Array(Buffer.from(picture.data,'base64')),JPEG);
    const wrong=await rpc(f.env,'save_classification',{id:claimed.id,leaseId:'WRONG',revision:claimed.revision,sourceSha256:claimed.sourceSha256,reviewer:'gpt',status:'classified',marks:[]});
    assert.equal(wrong.result.isError,true);
    const ok=await rpc(f.env,'save_classification',{id:claimed.id,leaseId:claimed.leaseId,revision:claimed.revision,sourceSha256:claimed.sourceSha256,reviewer:'gpt',status:'classified',marks:[{x:0.1,y:0.2,kind:'navigate',label:'Open'}]});
    assert.equal(JSON.parse(ok.result.content[0].text).saved,true);
    const im=await get(f.env,`/v1/items/${encodeURIComponent(created.id)}/image`);assert.equal(im.status,200);assert.deepEqual(new Uint8Array(await im.arrayBuffer()),JPEG);
  }finally{f.close()}
});

test('replace on changed screenshot rejects stale classifier and excludes obsolete decision from feed',async()=>{
  const f=fixture();try{
    const a=(await (await upload(f.env,imageItem())).json()).item;
    const leased=(await (await request(f.env,'/v1/claim',{})).json()).item;
    const edited=new Uint8Array(JPEG);edited[4]=60;
    assert.equal((await upload(f.env,imageItem(),edited)).status,409);
    const payload=imageItem({replace:true});
    const replaced=(await (await upload(f.env,payload,edited)).json()).item;
    assert.notEqual(a.sourceSha256,replaced.sourceSha256);
    const res=await request(f.env,'/v1/save',{id:leased.id,leaseId:leased.leaseId,revision:leased.revision,sourceSha256:leased.sourceSha256,reviewer:'gpt',status:'classified',marks:[]});
    assert.equal(res.status,409);
    assert.equal(replaced.status,'pending');
  }finally{f.close()}
});

test('batch of structured providers, independent claims, zero marks and MCP authentication',async()=>{
  const f=fixture();try{
    const payload={items:[item({provider:'playtech',gameId:'a'}),item({provider:'3oaks',gameId:'b'})]};
    assert.equal((await request(f.env,'/v1/items/batch',payload,'ingest-test')).status,201);
    assert.equal((await get(f.env,'/v1/stats')).status,200);
    const claimed=(await (await request(f.env,'/v1/claim',{provider:'3oaks'})).json()).item;
    assert.equal(claimed.provider,'3oaks');
    const save=await request(f.env,'/v1/save',{id:claimed.id,leaseId:claimed.leaseId,revision:claimed.revision,sourceSha256:claimed.sourceSha256,reviewer:'gpt',status:'classified',marks:[],selections:[]});
    assert.equal(save.status,200);
    const other=(await (await request(f.env,'/v1/claim',{provider:'playtech'})).json()).item;
    assert.equal(other.provider,'playtech');
    const released=await request(f.env,'/v1/release',{id:other.id,leaseId:other.leaseId,revision:other.revision});assert.equal(released.status,200);
    assert.equal((await get(f.env,'/mcp','review-test')).status,401);
    const stats=(await (await get(f.env,'/v1/stats')).json()).counts;assert.deepEqual(stats,{pending:1,leased:0,classified:1,needs_review:0});
  }finally{f.close()}
});

test('prior classification is not emitted once a changed capture is explicitly replaced',async()=>{
  const f=fixture();try{
    await upload(f.env,imageItem());
    const c=(await (await request(f.env,'/v1/claim',{})).json()).item;
    const saved=await request(f.env,'/v1/save',{id:c.id,leaseId:c.leaseId,revision:c.revision,sourceSha256:c.sourceSha256,status:'classified',reviewer:'gpt',marks:[{x:0.3,y:0.4,kind:'buy',label:'old'}]});
    assert.equal(saved.status,200);
    const before=(await (await get(f.env,'/v1/decisions')).json()).items;assert.equal(before.length,1);
    const changed=new Uint8Array(JPEG);changed[2]=99;
    const replaced=(await upload(f.env,imageItem({replace:true}),changed));assert.equal(replaced.status,201);
    const after=(await (await get(f.env,'/v1/decisions')).json()).items;assert.equal(after.length,0);
  }finally{f.close()}
});

test('MCP structured task has no image payload, tools list is present and auth rejects wrong token',async()=>{
  const f=fixture();try{
    await upload(f.env,item(),null);
    const next=await rpc(f.env,'next_item',{});assert.equal(next.result.content.length,1);
    const itemInfo=JSON.parse(next.result.content[0].text).item;assert.equal(itemInfo.candidates[0].label,'BUY FEATURE');
    const bad=await worker.fetch(new Request('https://worker.example/mcp',{method:'POST',headers:{Authorization:'Bearer review-test','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}),f.env);
    assert.equal(bad.status,401);
    const list=await worker.fetch(new Request('https://worker.example/mcp',{method:'POST',headers:{Authorization:'Bearer mcp-test','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}),f.env);
    assert.equal((await list.json()).result.tools.length,13);
  }finally{f.close()}
});


test('audit_classifications lists saved decisions with candidates, pagination and no mutations',async()=>{
  const f=fixture();try{
    for(const name of ['alpha','beta','gamma']){
      await upload(f.env,item({gameId:name}),null);
      const c=(await (await request(f.env,'/v1/claim',{provider:'pragmatic'})).json()).item;
      const saved=await request(f.env,'/v1/save',{id:c.id,leaseId:c.leaseId,revision:c.revision,sourceSha256:c.sourceSha256,
        reviewer:'other-chat',status:'classified',selections:[{candidateId:'c0',kind:'buy'}]});
      assert.equal(saved.status,200);
    }
    const first=await rpc(f.env,'audit_classifications',{runId:'test-run',limit:2});
    const page1=JSON.parse(first.result.content[0].text);
    assert.equal(page1.items.length,2);assert.equal(page1.hasMore,true);
    assert.equal(page1.items[0].candidates[0].path,'GameRoot/BuyFeature/Collider');
    assert.equal(page1.items[0].decisions.allMarks[0].kind,'buy');
    const second=await rpc(f.env,'audit_classifications',{runId:'test-run',limit:2,afterId:page1.nextAfterId});
    const page2=JSON.parse(second.result.content[0].text);
    assert.equal(page2.items.length,1);assert.equal(page2.hasMore,false);assert.equal(page2.nextAfterId,null);
    const lite=await rpc(f.env,'audit_classifications',{includeCandidates:false,limit:1});
    assert.equal(Object.hasOwn(JSON.parse(lite.result.content[0].text).items[0],'candidates'),false);
    const bad=await rpc(f.env,'audit_classifications',{limit:100});
    assert.equal(bad.result.isError,true);
    const counts=(await (await get(f.env,'/v1/stats')).json()).counts;
    assert.deepEqual(counts,{pending:0,leased:0,classified:3,needs_review:0});
  }finally{f.close()}
});

test('audit_item reads a classified R2 image without lease, rejects pending and wrong auth',async()=>{
  const f=fixture();try{
    const created=(await (await upload(f.env,imageItem())).json()).item;
    const before=await rpc(f.env,'audit_item',{id:created.id,includeImage:true});
    assert.equal(before.result.isError,true);
    const c=(await (await request(f.env,'/v1/claim',{})).json()).item;
    await request(f.env,'/v1/save',{id:c.id,leaseId:c.leaseId,revision:c.revision,sourceSha256:c.sourceSha256,
      reviewer:'gpt',status:'classified',marks:[{x:0.4,y:0.6,kind:'navigate',label:'intro'}]});
    const audited=await rpc(f.env,'audit_item',{id:created.id,includeImage:true});
    assert.equal(audited.result.content.length,2);
    assert.equal(JSON.parse(audited.result.content[0].text).item.decisions.marks[0].x,0.4);
    assert.deepEqual(new Uint8Array(Buffer.from(audited.result.content[1].data,'base64')),JPEG);
    const response=await worker.fetch(new Request('https://worker.example/mcp',{method:'POST',headers:{Authorization:'Bearer ingest-test','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'audit_item',arguments:{id:created.id}}})}),f.env);
    assert.equal(response.status,401);
  }finally{f.close()}
});

test('sanitized action evidence is private, idempotent, source revision checked, and independently retrievable',async()=>{
 const f=fixture();try{
  const root=(await (await upload(f.env,item(),null)).json()).item;
  const c=(await (await request(f.env,'/v1/claim',{})).json()).item;
  await request(f.env,'/v1/save',{id:c.id,leaseId:c.leaseId,revision:c.revision,sourceSha256:c.sourceSha256,reviewer:'gpt',status:'classified',selections:[{candidateId:'c0',kind:'buy'}]});
  const parent=(await (await get(f.env,'/v1/items/'+encodeURIComponent(root.id))).json()).item;
  const childMeta={parentId:root.id,parentSourceSha256:parent.sourceSha256,parentRevision:parent.revision,actionPath:[{kind:'buy',label:'BUY FEATURE',x:.3,y:.4,state:'BASE'}]};
  const child=(await (await upload(f.env,item({shotId:'step-abcdef',mode:'visual',adapter:'opaque-canvas',candidates:[],metadata:childMeta}))).json()).item;
  const trace={log:{version:'1.2',entries:[{request:{method:'POST',url:'https://demogamesfree.pragmaticplay.net/gs2c/v3/gameService',postData:{text:'action=doSpin&bet=2'}},response:{status:200}}],_webSockets:[],_notice:'Sanitized DEMO diagnostics.'}};
  const data={traceId:'a'.repeat(64),runId:'test-run',provider:'pragmatic',gameId:'demo-a',parentId:root.id,parentSourceSha256:parent.sourceSha256,parentRevision:parent.revision,childId:child.id,trace};
  assert.equal((await request(f.env,'/v1/traces',data,'review-test')).status,401);
  const one=await request(f.env,'/v1/traces',data,'ingest-test');assert.equal(one.status,201);
  const again=await request(f.env,'/v1/traces',data,'ingest-test');assert.equal(again.status,201);
  const privateGet=await get(f.env,'/v1/traces/'+data.traceId,'ingest-test');assert.equal(privateGet.status,401);
  const response=await get(f.env,'/v1/traces/'+data.traceId);assert.equal(response.status,200);
  assert.equal((await response.json()).trace.log.entries[0].request.postData.text,'action=doSpin&bet=2');
  const changed=await request(f.env,'/v1/traces',{...data,parentSourceSha256:'b'.repeat(64),traceId:'b'.repeat(64)},'ingest-test');assert.equal(changed.status,409);
 }finally{f.close();}
});


test('health restores only the missing additive trace table without disturbing classified items',async()=>{
  const f=fixture({withoutTraces:true});try{
    const before=await f.env.DB.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name=?').bind('action_traces').first();
    assert.equal(before.count,0);
    const response=await get(f.env,'/health');
    assert.equal(response.status,200);
    assert.equal((await response.json()).schemaVersion,2);
    const after=await f.env.DB.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name=?').bind('action_traces').first();
    assert.equal(after.count,1);
    assert.equal((await get(f.env,'/health')).status,200);
    assert.equal((await get(f.env,'/v1/stats')).status,200);
  }finally{f.close()}
});

test('game-specific unresolved status is private, paginated, and never hides a failed sibling',async()=>{
 const f=fixture();try{
  // One healthy game, one game waiting on a new child, one needing review.
  await upload(f.env,item({gameId:'gamma'}),null);
  const gamma=(await (await request(f.env,'/v1/claim',{runId:'test-run',provider:'pragmatic'})).json()).item;
  await request(f.env,'/v1/save',{id:gamma.id,leaseId:gamma.leaseId,revision:gamma.revision,sourceSha256:gamma.sourceSha256,
    reviewer:'gpt',status:'classified',selections:[{candidateId:'c0',kind:'buy'}]});
  await upload(f.env,item({gameId:'alpha',shotId:'child'}),null);
  await upload(f.env,item({gameId:'beta'}),null);
  // Claim alpha then release, claim beta and mark it as needing review.
  const a=(await (await request(f.env,'/v1/claim',{runId:'test-run'})).json()).item;
  assert.equal(a.gameId,'alpha');
  await request(f.env,'/v1/release',{id:a.id,leaseId:a.leaseId,revision:a.revision});
  // alpha would win the next FIFO claim; mark it leased while saving beta.
  const again=(await (await request(f.env,'/v1/claim',{runId:'test-run'})).json()).item;
  assert.equal(again.gameId,'alpha');
  const beta=(await (await request(f.env,'/v1/claim',{runId:'test-run'})).json()).item;
  assert.equal(beta.gameId,'beta');
  await request(f.env,'/v1/save',{id:beta.id,leaseId:beta.leaseId,revision:beta.revision,sourceSha256:beta.sourceSha256,
    reviewer:'gpt',status:'needs_review',selections:[]});

  assert.equal((await get(f.env,'/v1/game-blockers?runId=test-run','ingest-test')).status,401);
  assert.equal((await get(f.env,'/v1/game-blockers')).status,400);
  const page1=(await (await get(f.env,'/v1/game-blockers?runId=test-run&limit=1')).json());
  assert.equal(page1.items.length,1);assert.equal(page1.items[0].gameId,'alpha');
  assert.equal(page1.items[0].leased,1);assert.equal(page1.hasMore,true);
  const page2=(await (await get(f.env,'/v1/game-blockers?runId=test-run&limit=1&after='+encodeURIComponent(page1.nextAfter))).json());
  assert.equal(page2.items[0].gameId,'beta');
  assert.equal(page2.items[0].needs_review,1);assert.equal(page2.hasMore,false);
  assert.equal((await get(f.env,'/v1/game-blockers?runId=test-run&after=invalid%2F%2Fcursor')).status,400);
  const empty=(await (await get(f.env,'/v1/game-blockers?runId=other-run')).json());
  assert.deepEqual(empty.items,[]);
 }finally{f.close();}
});
