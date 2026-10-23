#!/usr/bin/env node
// Inspect or replay sanitized HTTP calls on explicitly authorized PUBLIC DEMO origin.
// POST is disabled by default; no cookies, tokens, WebSocket sessions or retry are generated.
import fs from 'node:fs/promises';
import {cli} from './utils.js';
import {prepareReplay,replayTrace} from './replay.js';
const args=cli(process.argv.slice(2));
if(args.help){console.log('node local/replay-demo.mjs --trace=outbox/diagnostics/step.har --origin=https://demo.example --contains=doSpin [--send]');process.exit(0);}
if(!args.trace||!args.origin||!args.contains)throw Error('Specify --trace, --origin and --contains to select an explicitly approved demo request');
const origins=String(args.origin).split(',').map(v=>new URL(v).origin);
const data=JSON.parse(await fs.readFile(args.trace,'utf8'));
const chosen={log:{...data.log,entries:(data.log?.entries||[]).filter(e=>(e.request?.url||'').includes(args.contains)||(e.request?.postData?.text||'').includes(args.contains)),_webSockets:[]}};
if(!chosen.log.entries.length)throw Error('No matching HTTP request in sanitized HAR; WebSocket-only actions cannot use HTTP replay');
const commands=prepareReplay(chosen,{allowedOrigins:origins});
if(commands.length>10)throw Error('Too many requests; filter to a specific observed action');
console.log(JSON.stringify({mode:args.send?'replay':'dry-run',requests:commands.map(c=>({method:c.method,url:c.url,body:c.body,contentType:c.contentType}))},null,2));
if(args.send){
 const results=await replayTrace(chosen,{allowedOrigins:origins,allowMutating:true});
 console.log(JSON.stringify({replayed:results},null,2));
}
