import {requiredId} from './candidates.js';
import {publicItem} from './core.js';
import {reviewedAction,eligibleReviewedPath} from './action-plan.js';
const parse=(s,fallback)=>{try{return JSON.parse(s)||fallback;}catch{return fallback;}};
export function summarizeProgress(rows){
 const games=new Map();
 for(const row of rows){
  const key=row.provider+'/'+row.game_id;
  if(!games.has(key))games.set(key,{provider:row.provider,gameId:row.game_id,captures:0,classified:0,pending:0,review:0,evidence:0,actionKeys:[],controls:new Map()});
  const game=games.get(key);game.captures++;
  if(row.status==='classified')game.classified++;
  if(['pending','leased'].includes(row.status))game.pending++;
  if(row.status==='needs_review')game.review++;
  const meta=parse(row.metadata_json,{});
  if(meta.terminal===true&&meta.evidenceStatus==='bet_request_observed')game.evidence++;
  if(row.status!=='classified')continue;
  for(const [index,action] of (parse(row.decisions_json,{}).allMarks||[]).entries()){
   const label=String(action.label||'').trim();
   if(/cookies?|reject all|consent|age gate/i.test(label))continue;
   const category=/ante|higher.*chance|double.*chance|bet.*higher/i.test(label)?'anteBets':action.kind==='buy'?'buys':action.kind==='pick'?'choices':action.kind==='navigate'?'navigation':'other';
   // The same reviewed control can occur in several screenshots. Count it once.
   game.controls.set(category+'/'+label.toLowerCase(),category);
   try{
    const action=reviewedAction(publicItem(row),index);
    if(!meta.terminal&&eligibleReviewedPath(action,meta.actionPath||[]))game.actionKeys.push(JSON.stringify([row.id,row.revision,row.source_sha256,index]));
   }catch{ /* Invalid/stale controls cannot be scheduled by either consumer. */ }
  }
 }
 const result=[...games.values()].map(({controls,...game})=>{
  const counts={buys:0,anteBets:0,choices:0,navigation:0,other:0};
  for(const category of controls.values())counts[category]++;
  // Only the local owner has the execution journal. Cloud evidence alone is not
  // proof that all reviewed sibling branches have finished.
  const finished=false;
  const state=game.review?'Revisar':game.pending?'Pendiente clasificacion':game.evidence?'Evidencia observada; comprobar ramas':game.classified?'Clasificado; sin cierre demostrado':'Sin clasificar';
  return {...game,...counts,finished,state};
 }).sort((a,b)=>a.provider.localeCompare(b.provider)||a.gameId.localeCompare(b.gameId));
 return {games:result,providers:providerTotals(result)};
}
export function providerTotals(games){
 const providers=new Map();
 for(const game of games){
  if(!providers.has(game.provider))providers.set(game.provider,{provider:game.provider,total:0,processed:0,finished:0,unfinished:0,pending:0,review:0,buys:0,anteBets:0,choices:0});
  const p=providers.get(game.provider);p.total++;p.processed+=Number(game.classified>0);p.finished+=Number(game.finished);p.unfinished+=Number(!game.finished);
  p.pending+=Number(game.pending>0);p.review+=Number(game.review>0);
  for(const k of ['buys','anteBets','choices'])p[k]+=game[k]||0;
 }
 return [...providers.values()].sort((a,b)=>a.provider.localeCompare(b.provider));
}
export async function progressReport(env,{runId}={}){
 requiredId(runId,'runId');
 const {results}=await env.DB.prepare('SELECT id,revision,source_sha256,image_key,image_sha256,width,height,provider,game_id,state,status,candidates_json,decisions_json,metadata_json FROM items WHERE run_id=? ORDER BY provider,game_id').bind(runId).all();
 return {runId,updatedAt:new Date().toISOString(),...summarizeProgress(results||[])};
}
