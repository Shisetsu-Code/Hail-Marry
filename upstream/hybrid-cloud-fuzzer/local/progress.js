import {providerTotals} from '../src/progress.js';
export function mergeProgress(cloud,manifest,journal={entries:{}}){
 if(cloud.runId!==manifest.runId)throw Error('Progress run does not match local manifest');
 const map=new Map((cloud.games||[]).map(g=>[g.provider+'/'+g.gameId,{...g,executed:0,blocked:0,uncertain:0}]));
 for(const item of manifest.games||[]){
  const key=item.provider+'/'+item.id;
  if(item.enabled!==false&&!map.has(key))map.set(key,{provider:item.provider,gameId:item.id,state:'Sin captura',captures:0,classified:0,pending:0,review:0,evidence:0,buys:0,anteBets:0,choices:0,navigation:0,other:0,finished:false,executed:0,blocked:0,uncertain:0});
 }
 const completedActions=new Set();
 for(const entry of Object.values(journal.entries||{})){
  if(entry.task?.runId!==manifest.runId)continue;
  const game=map.get(entry.task?.provider+'/'+entry.task?.gameId);if(!game)continue;
  if(entry.status==='done'){
   game.executed++;
   completedActions.add(JSON.stringify([entry.task.parentId,entry.task.parentRevision,entry.task.parentSourceSha256,entry.task.actionIndex]));
  }
  if(entry.status==='blocked'||entry.status==='failed')game.blocked++;
  if(entry.status==='uncertain')game.uncertain++;
 }
 const games=[...map.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.gameId.localeCompare(b.gameId));
 for(const game of games){
  game.remainingActions=(game.actionKeys||[]).filter(key=>!completedActions.has(key)).length;
  delete game.actionKeys;
  game.finished=game.evidence>0&&!game.pending&&!game.review&&!game.remainingActions&&!game.blocked&&!game.uncertain;
  if(game.uncertain||game.blocked)game.state=game.uncertain?'Incierto':'Bloqueado';
  else if(game.finished)game.state='Finalizado con evidencia';
  else if(game.remainingActions&&!game.pending&&!game.review)game.state='Ramas por ejecutar';
 }
 return {...cloud,games,providers:providerTotals(games)};
}
