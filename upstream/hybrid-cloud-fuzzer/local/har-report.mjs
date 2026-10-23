#!/usr/bin/env node
// Offline HAR diagnostics; suggests network signatures, not UI button positions.
import fs from 'node:fs/promises';
import {summarizeHar} from './har.js';
const file=process.argv[2];
if(!file||process.argv.length>3){console.error('Usage: node local/har-report.mjs outbox/diagnostics/<game>.har');process.exitCode=1;}
else{
  try{
    const har=JSON.parse(await fs.readFile(file,'utf8'));
    if(har?.log?.version!=='1.2'||!Array.isArray(har.log.entries))throw Error('Not a supported sanitized HAR');
    console.log(JSON.stringify({source:file,providerLearning:summarizeHar(har),note:'Network action hints only. Never infer visible buttons from HAR alone.'},null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
