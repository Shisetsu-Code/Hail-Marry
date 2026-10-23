import {InputError,publicItem,hashHex} from './core.js';
import {requiredId} from './candidates.js';
import {reviewedAction,eligibleReviewedPath} from './action-plan.js';
const hex=/^[a-f0-9]{64}$/;
async function ready(env){
 if(!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='branch_executions'").first())throw new InputError('branch coordination migration 0005 missing',503);
}
export async function branchExecutions(env,{runId,after='',limit=200}={}){
 requiredId(runId,'runId');await ready(env);
 if(typeof after!=='string'||after&&!hex.test(after)||!Number.isInteger(limit)||limit<1||limit>250)throw new InputError('invalid branch cursor/limit');
 const rows=(await env.DB.prepare('SELECT task_id,status,parent_id,child_id,reason,created_at,updated_at FROM branch_executions WHERE run_id=? AND task_id>? ORDER BY task_id LIMIT ?').bind(runId,after,limit+1).all()).results||[];
 const items=rows.slice(0,limit);return {items,hasMore:rows.length>limit,nextAfter:rows.length>limit?items.at(-1).task_id:null};
}
export async function claimBranch(env,{parentId,revision,sourceSha256,actionIndex,taskId}={}){
 await ready(env);
 if(typeof parentId!=='string'||parentId.length>400||!Number.isInteger(revision)||revision<1||!hex.test(sourceSha256||'')||!hex.test(taskId||'')||!Number.isInteger(actionIndex)||actionIndex<0||actionIndex>500)throw new InputError('invalid execution identity');
 const row=await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(parentId).first();
 if(!row||row.status!=='classified'||row.revision!==revision||row.source_sha256!==sourceSha256)throw new InputError('stale or unreviewed source',409);
 const item=publicItem(row),ancestors=item.metadata?.actionPath||[];
 let action;try{action=reviewedAction(item,actionIndex);}catch{throw new InputError('invalid reviewed action');}
 if(item.metadata?.terminal||!eligibleReviewedPath(action,ancestors))throw new InputError('action is not an eligible continuation',409);
 const expected=await hashHex(new TextEncoder().encode(JSON.stringify([item.id,item.revision,item.sourceSha256,actionIndex,[...ancestors,action]])));
 if(taskId!==expected)throw new InputError('execution identity mismatch',409);
 const existing=await env.DB.prepare('SELECT status FROM branch_executions WHERE task_id=?').bind(taskId).first();
 if(existing)return {acquired:false,status:existing.status};
 // Old traces and previously uploaded children also prove an action must not be replayed.
 const prior=await env.DB.prepare('SELECT trace_id FROM action_traces WHERE trace_id=?').bind(taskId).first();
 const child=await env.DB.prepare('SELECT id FROM items WHERE id=?').bind(`${item.runId}:${item.provider}:${item.gameId}:step-${taskId.slice(0,20)}`).first();
 if(prior||child)return {acquired:false,status:prior?'done':'uncertain',reason:'existing continuation evidence'};
 const token=crypto.randomUUID();
 const result=await env.DB.prepare(
  "INSERT OR IGNORE INTO branch_executions(task_id,run_id,provider,game_id,parent_id,parent_revision,parent_source_sha256,action_index,token,status) "+
  "SELECT ?,?,?,?,?,?,?,?,?,'running' WHERE EXISTS(SELECT 1 FROM items WHERE id=? AND status='classified' AND revision=? AND source_sha256=?) "+
  "AND NOT EXISTS(SELECT 1 FROM items WHERE run_id=? AND provider=? AND game_id=? AND status IN ('pending','leased','needs_review')) "+
  "AND NOT EXISTS(SELECT 1 FROM branch_executions WHERE run_id=? AND provider=? AND game_id=? AND status IN ('running','blocked','uncertain'))")
  .bind(taskId,item.runId,item.provider,item.gameId,item.id,revision,sourceSha256,actionIndex,token,item.id,revision,sourceSha256,item.runId,item.provider,item.gameId,item.runId,item.provider,item.gameId).run();
 return result.meta?.changes===1?{acquired:true,taskId,token,status:'running'}:{acquired:false,status:'waiting',reason:'game unresolved or already reserved'};
}
export async function finishBranch(env,{taskId,token,status,reason=null,childId=null}={}){
 await ready(env);
 if(!hex.test(taskId||'')||typeof token!=='string'||token.length>100||!['done','blocked','uncertain'].includes(status)||reason!==null&&(typeof reason!=='string'||reason.length>350))throw new InputError('invalid execution result');
 const row=await env.DB.prepare('SELECT * FROM branch_executions WHERE task_id=? AND token=?').bind(taskId,token).first();
 if(!row)throw new InputError('execution ownership mismatch',409);
 if(row.status!=='running'){
  if(row.status===status&&row.child_id===childId)return {ok:true,unchanged:true};
  throw new InputError('execution already finalized',409);
 }
 if(status==='done'){
  const trace=await env.DB.prepare('SELECT * FROM action_traces WHERE trace_id=?').bind(taskId).first();
  if(!trace||trace.parent_item_id!==row.parent_id||trace.parent_revision!==row.parent_revision||trace.parent_source_sha256!==row.parent_source_sha256||trace.child_item_id!==childId)throw new InputError('completed execution requires matching child and trace',409);
 }else if(!reason)throw new InputError('failure reason required');
 const result=await env.DB.prepare("UPDATE branch_executions SET status=?,child_id=?,reason=?,updated_at=datetime('now') WHERE task_id=? AND token=? AND status='running'").bind(status,childId,reason,taskId,token).run();
 if(result.meta?.changes!==1)throw new InputError('execution changed concurrently',409);
 return {ok:true,status};
}
