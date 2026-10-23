import {InputError,requiredId} from './candidates.js';
import {hashHex} from './core.js';
const hex=/^[a-f0-9]{64}$/i;
const idPattern=/^[a-z0-9][a-z0-9_.:-]{0,399}$/i;
export async function recordTrace(env,data){
 if(!data||typeof data!=='object'||!hex.test(data.traceId||''))throw new InputError('invalid trace ID');
 for(const key of ['runId','provider','gameId'])requiredId(data[key],key);
 for(const key of ['parentId','childId'])if(!idPattern.test(data[key]||''))throw new InputError('invalid '+key);
 if(!hex.test(data.parentSourceSha256||'')||!Number.isSafeInteger(data.parentRevision)||data.parentRevision<1)throw new InputError('invalid classified source identity');
 if(!data.trace?.log||!Array.isArray(data.trace.log.entries)||!Array.isArray(data.trace.log._webSockets)||!/Sanitized DEMO/i.test(data.trace.log._notice||''))throw new InputError('expected sanitized DEMO HAR');
 if(data.trace.log.entries.length>500||data.trace.log._webSockets.length>200)throw new InputError('trace entry limit exceeded',413);
 const serialized=JSON.stringify(data.trace);
 if(serialized.length>350000)throw new InputError('trace too large; save full HAR locally and trim remote snapshot',413);
 const [parent,child]=await Promise.all([
  env.DB.prepare('SELECT * FROM items WHERE id=?').bind(data.parentId).first(),
  env.DB.prepare('SELECT * FROM items WHERE id=?').bind(data.childId).first()
 ]);
 if(!parent||parent.status!=='classified'||parent.source_sha256!==data.parentSourceSha256||parent.revision!==data.parentRevision)throw new InputError('stale parent classification',409);
 if(!child||parent.run_id!==data.runId||child.run_id!==data.runId||parent.provider!==data.provider||child.provider!==data.provider||parent.game_id!==data.gameId||child.game_id!==data.gameId)throw new InputError('trace game mismatch',409);
 let metadata;try{metadata=JSON.parse(child.metadata_json);}catch{metadata={};}
 if(metadata.parentId!==parent.id||metadata.parentSourceSha256!==parent.source_sha256||metadata.parentRevision!==parent.revision)throw new InputError('child does not prove reviewed ancestry',409);
 const bytes=new TextEncoder().encode(serialized),hash=await hashHex(bytes),key=`traces/${data.runId}/${data.provider}/${data.gameId}/${data.traceId}.json`;
 const existing=await env.DB.prepare('SELECT * FROM action_traces WHERE trace_id=?').bind(data.traceId).first();
 if(existing){if(existing.content_sha256!==hash||existing.parent_item_id!==data.parentId||existing.child_item_id!==data.childId)throw new InputError('conflicting action evidence',409);return {ok:true,unchanged:true,traceId:data.traceId};}
 await env.IMAGES.put(key,serialized,{httpMetadata:{contentType:'application/json'}});
 try{await env.DB.prepare('INSERT INTO action_traces(trace_id,parent_item_id,child_item_id,parent_source_sha256,parent_revision,storage_key,content_sha256) VALUES(?,?,?,?,?,?,?)')
  .bind(data.traceId,data.parentId,data.childId,data.parentSourceSha256,data.parentRevision,key,hash).run();}
 catch(e){const found=await env.DB.prepare('SELECT * FROM action_traces WHERE trace_id=?').bind(data.traceId).first();if(found?.content_sha256===hash)return {ok:true,unchanged:true,traceId:data.traceId};throw e;}
 return {ok:true,traceId:data.traceId};
}
export async function retrieveTrace(env,id){
 if(!hex.test(id||''))throw new InputError('invalid trace ID');
 const row=await env.DB.prepare('SELECT * FROM action_traces WHERE trace_id=?').bind(id).first();
 if(!row)throw new InputError('trace not found',404);
 const body=await env.IMAGES.get(row.storage_key);if(!body)throw new InputError('stored trace unavailable',404);
 return {traceId:id,parentId:row.parent_item_id,childId:row.child_item_id,parentRevision:row.parent_revision,
  sourceSha256:row.parent_source_sha256,trace:JSON.parse(await body.text())};
}
