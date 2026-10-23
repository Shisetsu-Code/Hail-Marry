#!/usr/bin/env node
// Opt-in live DEMO speed control and sanitized HAR recording via LOCAL Chromium CDP.
// No clicks, spins, purchases, account access or game server changes.
import path from 'node:path';
import {cli} from './utils.js';
import {validateSpeed,speedUpGame} from './speed.js';
import {createNetworkRecorder,saveSanitizedHar} from './har.js';
const args=cli(process.argv.slice(2));
if(args.help){console.log('node local/speed-control.mjs --cdp=http://127.0.0.1:9222 --host=demogamesfree.pragmaticplay.net --speed=4 [--watch] [--har=outbox/diagnostics/session.har --seconds=90]');process.exit(0);}
const factor=validateSpeed(args.speed||4);
if(!args.host||!args.cdp)throw Error('--cdp and --host are required; only local Chromium debugging ports are allowed');
const endpoint=new URL(String(args.cdp));
if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!endpoint.port||endpoint.username||endpoint.password)throw Error('CDP endpoint must be local http://127.0.0.1:<port>');
const host=String(args.host).toLowerCase();
if(!/^[a-z0-9.-]+$/.test(host)||!host.includes('.'))throw Error('Invalid demo host');
const duration=Number(args.seconds||60);
if(!Number.isInteger(duration)||duration<1||duration>3600)throw Error('seconds must be 1..3600');
const allow=url=>{try{const name=new URL(url).hostname.toLowerCase();return name===host||name.endsWith('.'+host);}catch{return false;}};
const {chromium}=await import('playwright');
const browser=await chromium.connectOverCDP(endpoint.toString());
let count=0;
async function apply(){
  for(const context of browser.contexts())for(const page of context.pages())for(const frame of page.frames()){
    if(!allow(frame.url()))continue;
    const r=await speedUpGame(page,frame,factor);
    if(r.installed)count++;
  }
}
let recorder=null;
try{
  await apply();console.log(`Speed ${factor}x applied to ${count} matching frame(s)`);
  if(args.har){
    const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.frames().some(f=>allow(f.url())));
    if(!page)throw Error('No matching demo tab found for HAR capture');
    recorder=createNetworkRecorder(page,{urlFilter:allow});
    console.log(`Recording sanitized demo HAR for ${duration}s. Interact with the DEMO in the existing browser.`);
  }
  if(args.watch||args.har){
    if(args.watch)console.log('Watching for new demo frames. Ctrl+C to stop.');
    let stop=false;process.once('SIGINT',()=>{stop=true;});process.once('SIGTERM',()=>{stop=true;});
    const until=Date.now()+duration*1000;
    while(!stop&&(!args.har||Date.now()<until)){
      await new Promise(resolve=>setTimeout(resolve,Math.min(2000,Math.max(1,until-Date.now()))));
      if(args.watch)await apply();
    }
  }
}finally{
  if(recorder){
    const {har,summary}=await recorder.finish();
    const file=path.resolve(String(args.har));await saveSanitizedHar(file,har);
    console.log(`HAR saved: ${file} (${summary.requests} requests, ${summary.webSocketFrames} WebSocket frames)`);
  }
  await browser.close();
}
