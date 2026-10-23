// Read-only cloud audit and explicit manifest for the selected classification run.
import path from 'node:path';
import {CloudClient} from '../local/cloud-client.js';
import {cli,safeId,writeAtomic} from '../local/utils.js';
import {collectTasks} from '../local/rounds.js';
const args=cli(process.argv.slice(2)),runId=safeId(args['run-id'],'runId');
const cloud=new CloudClient({endpoint:process.env.HYBRID_FUZZER_URL,reviewToken:process.env.HYBRID_REVIEW_TOKEN,ingestToken:process.env.HYBRID_INGEST_TOKEN});
const decisions=await cloud.allDecisions(runId),blocked=await cloud.blockedGames(runId);
const items=[];
for(const decision of decisions)items.push(await cloud.item(decision.id));
const games=[...new Map(items.map(item=>{
 const url=item.provider==='pragmatic'?`https://www.pragmaticplay.fun/en/slots/${item.gameId}/`:item.metadata?.url;
 return [item.provider+'/'+item.gameId,{provider:item.provider,id:item.gameId,url}];
})).values()].filter(game=>game.url);
const manifest={runId,games};
const tasks=collectTasks(items.filter(item=>!blocked.has(item.provider+'/'+item.gameId)));
const dir=path.resolve('.local-state','continuations-'+runId);
await writeAtomic(path.join(dir,'manifest.json'),manifest);
const report={at:new Date().toISOString(),runId,classified:items.length,readyGames:new Set(tasks.map(t=>t.provider+'/'+t.gameId)).size,actions:tasks.length,blockedGames:blocked.size,manifest:path.join(dir,'manifest.json'),outbox:path.resolve('outbox','continuations-'+runId)};
await writeAtomic(path.join(dir,'plan.json'),report);console.log(JSON.stringify(report,null,2));
