import test from 'node:test';
import assert from 'node:assert/strict';
import {verify} from '../scripts/verify-deployment.mjs';

const names=['next_item','save_classification','save_and_next','get_item','release_item','queue_stats'];
function mock(url,opts={}){
  if(url.endsWith('/health'))return new Response(JSON.stringify({ok:true,schemaVersion:4,workforceReady:true,pacingReady:true,service:'hybrid-cloud-fuzzer'}));
  if(url.endsWith('/v1/stats')){assert.equal(opts.headers.Authorization,'Bearer review-secret');return new Response(JSON.stringify({counts:{pending:3,leased:0,classified:1,needs_review:0},total:4}));}
  if(url.endsWith('/mcp')){
    assert.equal(opts.headers.Authorization,'Bearer mcp-secret');
    const body=JSON.parse(opts.body);
    const result=body.method==='initialize'?{serverInfo:{name:'hybrid-cloud-fuzzer'}}:{tools:names.map(name=>({name}))};
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
  }
  throw Error('Unexpected URL');
}
test('deployment probe validates D1 and every expected MCP capability without mutation',async()=>{
 const result=await verify({url:'https://hybrid.example.workers.dev',mcpToken:'mcp-secret',reviewToken:'review-secret',fetcher:mock});
 assert.equal(result.ok,true);assert.equal(result.queue.pending,3);assert.deepEqual(result.tools,names);
 assert.equal(result.schemaVersion,4);
});
test('deployment probe rejects missing bindings or MCP tools',async()=>{
 await assert.rejects(verify({url:'https://hybrid.example.workers.dev',mcpToken:'mcp-secret',reviewToken:'review-secret',fetcher:()=>new Response(JSON.stringify({ok:false}),{status:503})}),/HTTP 503/);
 await assert.rejects(verify({url:'http://example.net',mcpToken:'mcp-secret',reviewToken:'review-secret',fetcher:mock}),/HTTPS/);
});

test('deployment probe rejects old schema 2 even when legacy health and MCP respond',async()=>{
 const old=(url,options={})=>{
  if(url.endsWith('/health'))
   return new Response(JSON.stringify({ok:true,schemaVersion:2,workforceReady:false,pacingReady:false}));
  return mock(url,options);
 };
 await assert.rejects(
  verify({url:'https://hybrid.example.workers.dev',mcpToken:'mcp-secret',
   reviewToken:'review-secret',fetcher:old}),/schema 0004/i);
});
