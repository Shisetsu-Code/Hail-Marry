#!/usr/bin/env node
// Read-only deployment smoke test: health, D1 stats and MCP tools, no data mutations.
import {pathToFileURL} from 'node:url';
export async function verify({url=process.env.HYBRID_FUZZER_URL,mcpToken=process.env.HYBRID_MCP_TOKEN,
  reviewToken=process.env.HYBRID_REVIEW_TOKEN,fetcher=fetch}={}){
  if(!/^https:\/\/[^/]+/.test(url||''))throw Error('HYBRID_FUZZER_URL (HTTPS) required');
  if(!mcpToken||!reviewToken)throw Error('Set HYBRID_MCP_TOKEN and HYBRID_REVIEW_TOKEN');
  const base=url.replace(/\/$/,'');
  async function request(endpoint,init){
    const response=await fetcher(base+endpoint,{...init,signal:AbortSignal.timeout(15000)});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(`${endpoint}: HTTP ${response.status} ${String(value.error||'').slice(0,100)}`);
    return value;
  }
  const health=await request('/health');
  if(health.ok!==true||Number(health.schemaVersion)<4||health.workforceReady!==true||health.pacingReady!==true)throw Error('Worker schema 0004 (workforce + provider pacing) is not ready');
  const stats=await request('/v1/stats',{headers:{Authorization:`Bearer ${reviewToken}`}});
  if(typeof stats.total!=='number')throw Error('Unexpected D1 stats response');
  const rpc=async(id,method,params={})=>request('/mcp',{method:'POST',headers:{Authorization:`Bearer ${mcpToken}`,'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const init=await rpc(1,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'deployment-check',version:'1'}});
  if(!init.result?.serverInfo?.name)throw Error('MCP initialize failed');
  const list=await rpc(2,'tools/list');
  const names=list.result?.tools?.map(x=>x.name)||[];
  for(const need of ['next_item','save_classification','save_and_next','get_item','release_item','queue_stats'])if(!names.includes(need))throw Error(`MCP tool ${need} missing`);
  return {ok:true,service:health.service,schemaVersion:health.schemaVersion,queue:stats.counts,tools:names};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await verify(),null,2));}catch(e){console.error('DEPLOYMENT CHECK FAILED:',e.message);process.exitCode=1;}
}
