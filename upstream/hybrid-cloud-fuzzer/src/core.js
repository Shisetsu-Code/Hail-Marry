import {InputError,validateItem,normalizeDecisions} from './candidates.js';
const shaPattern=/^[a-f0-9]{64}$/i;
const jpegMime='image/jpeg';
const bytesMax=8*1024*1024;
const dbDate="datetime('now')";
export {InputError};
function fromJSON(s,fallback){try{return JSON.parse(s);}catch{return fallback;}}
export async function hashHex(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
export function publicItem(row){if(!row)return null;return {
  id:row.id,runId:row.run_id,provider:row.provider,gameId:row.game_id,shotId:row.shot_id,
  mode:row.mode,state:row.state,adapter:row.adapter,adapterVersion:row.adapter_version,
  candidates:fromJSON(row.candidates_json,[]),metadata:fromJSON(row.metadata_json,{}),
  sourceSha256:row.source_sha256,imageSha256:row.image_sha256||null,hasImage:Boolean(row.image_key),
  width:row.width,height:row.height,status:row.status,revision:row.revision,
  leaseId:row.lease_id,leaseUntil:row.lease_until,decisions:fromJSON(row.decisions_json,null),
  createdAt:row.created_at,updatedAt:row.updated_at};
}
export async function ingest(env,payload,image=null,{replace=false}={}){
  const item=validateItem(payload);
  if(image!==null&&!(image instanceof ArrayBuffer))throw new InputError('expected JPEG arraybuffer');
  let imageHash=null,imageKey=null;
  if(image!==null){
    if(image.byteLength<4||image.byteLength>bytesMax)throw new InputError('JPEG size out of range',413);
    const b=new Uint8Array(image);if(b[0]!==255||b[1]!==216||b.at(-2)!==255||b.at(-1)!==217)throw new InputError('invalid JPEG',415);
    imageHash=await hashHex(image);imageKey=`images/${item.runId}/${item.provider}/${item.gameId}/${imageHash}.jpg`;
  }
  if(item.mode!=='structured'&&!imageHash)throw new InputError('hybrid/visual mode requires image');
  if(payload.imageSha256&&(typeof payload.imageSha256!=='string'||!shaPattern.test(payload.imageSha256)||payload.imageSha256.toLowerCase()!==imageHash))throw new InputError('image hash mismatch');
  const data={runId:item.runId,provider:item.provider,gameId:item.gameId,shotId:item.shotId,mode:item.mode,state:item.state,
    adapter:item.adapter,adapterVersion:item.adapterVersion,candidates:item.candidates,metadata:item.metadata,width:item.width,height:item.height,imageHash};
  const sourceSha=await hashHex(new TextEncoder().encode(JSON.stringify(data)));
  const existing=await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(item.id).first();
  if(existing?.source_sha256===sourceSha)return {...publicItem(existing),unchanged:true};
  if(existing&&!replace)throw new InputError('new content under existing shotId; pass replace=true explicitly',409);
  if(item.metadata?.source==='github-actions-catalogue'){
    const validation=item.metadata.captureValidation;
    if(validation?.reviewId){
      const review=await env.DB.prepare("SELECT * FROM capture_reviews WHERE id=? AND status='approved'").bind(validation.reviewId).first();
      if(!review||review.run_id!==item.runId||review.provider!==item.provider||review.game_id!==item.gameId||review.shot_id!==item.shotId||review.image_sha256!==imageHash||review.revision!==validation.revision)throw new InputError('GPT has not approved this exact capture',409);
    }else{
    if(!validation||!shaPattern.test(validation.reportId||''))throw new InputError('capture readiness validation required',409);
    const object=await env.IMAGES.get('validation/reports/'+item.runId+'/'+validation.reportId+'.json');
    let proof;try{proof=object?JSON.parse(await object.text()):null;}catch{}
    if(!proof||proof.runId!==item.runId||proof.provider!==item.provider||proof.gameId!==item.gameId||proof.sourceImageSha256!==imageHash||validation.status!==proof.status||!['ready','intro'].includes(proof.status))throw new InputError('capture validation does not approve this exact image',409);
    }
  }
  if(imageKey)await env.IMAGES.put(imageKey,image,{httpMetadata:{contentType:jpegMime},customMetadata:{sha256:imageHash}});
  const values=[item.state,item.mode,item.adapter,item.adapterVersion,JSON.stringify(item.candidates),JSON.stringify(item.metadata),sourceSha,imageKey,imageHash,item.width,item.height];
  if(existing){
    const updated=await env.DB.prepare(`UPDATE items SET state=?,mode=?,adapter=?,adapter_version=?,candidates_json=?,metadata_json=?,source_sha256=?,image_key=?,image_sha256=?,width=?,height=?,
      status='pending',decisions_json=NULL,reviewer=NULL,reviewed_at=NULL,lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=${dbDate}
      WHERE id=? AND source_sha256=? RETURNING *`).bind(...values,item.id,existing.source_sha256).first();
    if(!updated)throw new InputError('concurrent replacement; retry',409);
    return publicItem(updated);
  }
  try{
    await env.DB.prepare(`INSERT INTO items(id,run_id,provider,game_id,shot_id,state,mode,adapter,adapter_version,candidates_json,metadata_json,source_sha256,image_key,image_sha256,width,height)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(item.id,item.runId,item.provider,item.gameId,item.shotId,...values).run();
  }catch(e){
    const found=await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(item.id).first();
    if(found?.source_sha256===sourceSha)return {...publicItem(found),unchanged:true};
    throw new InputError('duplicate capture ID',409);
  }
  return publicItem(await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(item.id).first());
}
export async function rawItem(env,id){if(typeof id!=='string'||id.length>400)throw new InputError('invalid ID');const r=await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first();if(!r)throw new InputError('capture not found',404);return r;}
export async function claim(env,{runId=null,provider=null,mode=null,leaseSeconds=180}={}){
  if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>900)throw new InputError('leaseSeconds must be 30..900');
  if(runId&&!/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(runId))throw new InputError('invalid runId');
  if(provider&&!/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(provider))throw new InputError('invalid provider');
  if(mode!==null&&!['structured','hybrid','visual'].includes(mode))throw new InputError('invalid capture mode');
  const filters=["(status='pending' OR (status='leased' AND lease_until<=?))"],bind=[Math.floor(Date.now()/1000)];
  if(runId){filters.push('run_id=?');bind.push(runId);}if(provider){filters.push('provider=?');bind.push(provider);}
  if(mode){filters.push('mode=?');bind.push(mode);}
  const where=filters.join(' AND ');
  for(let i=0;i<4;i++){
    const lease=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
    const updated=await env.DB.prepare(`UPDATE items SET status='leased',lease_id=?,lease_until=?,revision=revision+1,updated_at=${dbDate}
      WHERE id=(SELECT id FROM items WHERE ${where} ORDER BY created_at ASC,id ASC LIMIT 1)
      AND (status='pending' OR (status='leased' AND lease_until<=?)) RETURNING *`)
      .bind(lease,now+leaseSeconds,...bind,now).first();
    if(updated)return publicItem(updated);
  }
  return null;
}
export async function save(env,payload){
  if(!payload||typeof payload!=='object')throw new InputError('JSON object required');
  const {id,leaseId,revision,sourceSha256,status,reviewer}=payload;
  if(typeof id!=='string'||id.length>400||typeof leaseId!=='string'||leaseId.length>150||!Number.isSafeInteger(revision)||revision<1)throw new InputError('invalid lease identity');
  if(!shaPattern.test(sourceSha256||''))throw new InputError('invalid source hash');
  if(!['classified','needs_review'].includes(status))throw new InputError('invalid status');
  if(typeof reviewer!=='string'||!reviewer.trim()||reviewer.length>80)throw new InputError('reviewer required');
  const raw=await rawItem(env,id);
  const decisions=normalizeDecisions(payload,fromJSON(raw.candidates_json,[]));
  const now=Math.floor(Date.now()/1000);
  // D1 batch executes as a transaction: never acknowledge a saved decision unless
  // the history/outgoing-feed entry was durably committed in the same transaction.
  const serialized=JSON.stringify(decisions),newRevision=revision+1;
  const update=env.DB.prepare(`UPDATE items SET status=?,decisions_json=?,reviewer=?,reviewed_at=${dbDate},revision=revision+1,
    lease_id=NULL,lease_until=NULL,updated_at=${dbDate}
    WHERE id=? AND status='leased' AND lease_id=? AND lease_until>? AND revision=? AND source_sha256=?`)
    .bind(status,serialized,reviewer.trim(),id,leaseId,now,revision,sourceSha256.toLowerCase());
  const history=env.DB.prepare(`INSERT OR IGNORE INTO decision_history(item_id,source_sha256,revision,reviewer,status,decisions_json)
    SELECT id,source_sha256,revision,?,?,? FROM items
    WHERE id=? AND revision=? AND status=? AND reviewer=? AND source_sha256=?`)
    .bind(reviewer.trim(),status,serialized,id,newRevision,status,reviewer.trim(),sourceSha256.toLowerCase());
  const [updated,recorded]=await env.DB.batch([update,history]);
  if(updated.meta?.changes!==1)throw new InputError('stale lease/revision/capture; claim again',409);
  if(recorded.meta?.changes!==1)throw new InputError('history consistency failure',500);
  return publicItem(await rawItem(env,id));
}
export async function release(env,{id,leaseId,revision}={}){
  if(typeof id!=='string'||typeof leaseId!=='string'||!Number.isSafeInteger(revision))throw new InputError('invalid release');
  const row=await env.DB.prepare(`UPDATE items SET status='pending',lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=${dbDate}
    WHERE id=? AND status='leased' AND lease_id=? AND revision=? RETURNING *`).bind(id,leaseId,revision).first();
  if(!row)throw new InputError('stale lease',409);return publicItem(row);
}
export async function stats(env,{runId=null,provider=null}={}){
  if(runId!=null&&!/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(runId))throw new InputError('invalid runId');
  if(provider!=null&&!/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(provider))throw new InputError('invalid provider');
  const where=[],vals=[];if(runId){where.push('run_id=?');vals.push(runId);}if(provider){where.push('provider=?');vals.push(provider);}
  const rows=await env.DB.prepare(`SELECT status,COUNT(*) AS count FROM items ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY status`).bind(...vals).all();
  const counts={pending:0,leased:0,classified:0,needs_review:0};for(const row of rows.results||[])if(row.status in counts)counts[row.status]=row.count;
  return {counts,total:Object.values(counts).reduce((a,b)=>a+b,0)};
}
// Read-only game-scoped barrier. A review failure in one game cannot block
// the other games of the same run. This endpoint deliberately lists *only*
// games with unresolved captures; it never returns credentials or screenshots.
// Cursor is a public "provider/gameId" pair, never an offset over a changing queue.
export async function gameBlockers(env,{runId,after='',limit=200}={}){
  const id=/^[a-z0-9][a-z0-9_.-]{0,99}$/i;
  if(typeof runId!=='string'||!id.test(runId))throw new InputError('valid runId required');
  if(typeof after!=='string'||(after&&!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(after))||after.length>201)throw new InputError('invalid game cursor');
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new InputError('invalid game page size');
  const rows=await env.DB.prepare(
    "SELECT provider,game_id, "+
    "SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, "+
    "SUM(CASE WHEN status='leased' THEN 1 ELSE 0 END) AS leased, "+
    "SUM(CASE WHEN status='needs_review' THEN 1 ELSE 0 END) AS needs_review "+
    "FROM items WHERE run_id=? AND status IN ('pending','leased','needs_review') "+
    "AND (provider || '/' || game_id)>? "+
    "GROUP BY provider,game_id ORDER BY (provider || '/' || game_id) LIMIT ?")
    .bind(runId,after,limit+1).all();
  const found=rows.results||[];
  const items=found.slice(0,limit).map(r=>({
    provider:r.provider,gameId:r.game_id,pending:Number(r.pending),leased:Number(r.leased),needs_review:Number(r.needs_review)
  }));
  const hasMore=found.length>limit;
  const last=items.at(-1);
  return {items,nextAfter:last?last.provider+'/'+last.gameId:after,hasMore};
}

export async function decisionsFeed(env,{runId=null,after=0,limit=50}={}){
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new InputError('invalid feed paging');
  if(runId&&!/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(runId))throw new InputError('invalid runId');
  const where=runId?'AND i.run_id=?':'';
  const rows=await env.DB.prepare(`SELECT h.id AS seq,h.item_id AS item_id,h.revision AS revision,h.decisions_json AS decisions_json,
      i.run_id AS run_id,i.provider AS provider,i.game_id AS game_id,i.shot_id AS shot_id,i.source_sha256 AS source_sha256
    FROM decision_history h JOIN items i ON i.id=h.item_id
    WHERE h.id>? ${where} AND h.source_sha256=i.source_sha256 AND h.revision=i.revision AND i.status='classified' ORDER BY h.id ASC LIMIT ?`)
    .bind(after,...(runId?[runId]:[]),limit).all();
  const items=(rows.results||[]).map(r=>({seq:r.seq,id:r.item_id,runId:r.run_id,provider:r.provider,gameId:r.game_id,shotId:r.shot_id,
    sourceSha256:r.source_sha256,revision:r.revision,decisions:fromJSON(r.decisions_json,{})}));
  return {items,nextAfter:items.length?items.at(-1).seq:after};
}

// Read-only audit of persisted decisions; includes original candidate paths and
// rectangles so reviewers can detect errors without exporting D1 to a local file.
export async function auditClassifications(env,{runId=null,provider=null,status='classified',afterId='',limit=20,includeCandidates=true}={}){
  const id=/^[a-z0-9][a-z0-9_.-]{0,99}$/i;
  if(runId!=null&&(typeof runId!=='string'||!id.test(runId)))throw new InputError('invalid runId');
  if(provider!=null&&(typeof provider!=='string'||!id.test(provider)))throw new InputError('invalid provider');
  if(!['classified','needs_review'].includes(status))throw new InputError('invalid audit status');
  if(typeof afterId!=='string'||afterId.length>400)throw new InputError('invalid audit cursor');
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new InputError('audit limit must be 1..50');
  if(typeof includeCandidates!=='boolean')throw new InputError('includeCandidates must be boolean');
  const where=['status=?','id>?'],values=[status,afterId];
  if(runId){where.push('run_id=?');values.push(runId);}
  if(provider){where.push('provider=?');values.push(provider);}
  const rows=await env.DB.prepare(`SELECT id,run_id,provider,game_id,shot_id,state,mode,adapter,revision,source_sha256,
    image_key,width,height,status,reviewer,reviewed_at,candidates_json,decisions_json
    FROM items WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`).bind(...values,limit+1).all();
  const result=rows.results||[],hasMore=result.length>limit;
  const items=result.slice(0,limit).map(row=>({
    id:row.id,runId:row.run_id,provider:row.provider,gameId:row.game_id,shotId:row.shot_id,
    state:row.state,mode:row.mode,adapter:row.adapter,status:row.status,revision:row.revision,
    sourceSha256:row.source_sha256,hasImage:Boolean(row.image_key),width:row.width,height:row.height,
    reviewer:row.reviewer,reviewedAt:row.reviewed_at,
    ...(includeCandidates?{candidates:fromJSON(row.candidates_json,[])}:{}),
    decisions:fromJSON(row.decisions_json,null)
  }));
  return {items,hasMore,nextAfterId:hasMore?items.at(-1).id:null};
}
