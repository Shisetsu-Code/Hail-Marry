#!/usr/bin/env node
// Stateless MCP stdio-to-Cloudflare bridge. Doesn't expose Cloudflare account credentials.
import readline from 'node:readline';
const url=(process.env.HYBRID_FUZZER_URL||'').replace(/\/$/,'')+'/mcp',token=process.env.HYBRID_MCP_TOKEN;
if(!url.startsWith('https://')||!token){console.error('Set HYBRID_FUZZER_URL and HYBRID_MCP_TOKEN');process.exit(1);}
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 if(!line.trim())continue;let id=null;try{id=JSON.parse(line).id??null;}catch{}
 try{const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:line});
   if(r.status===202)continue;if(!r.ok)throw Error(`Remote MCP HTTP ${r.status}`);
   process.stdout.write(JSON.stringify(await r.json())+'\n');}
 catch(e){if(id!==null)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:e.message}})+'\n');else console.error(e.message);}
}
