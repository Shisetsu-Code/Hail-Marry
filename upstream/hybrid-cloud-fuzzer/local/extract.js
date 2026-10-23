import {inspectDOM} from './adapters/dom.js';
import {inspectPragmatic} from './adapters/pragmatic.js';
import {inferMode,normalizeCandidates} from '../src/candidates.js';
const bestString=c=>String(c||'').slice(0,180).replace(/[\u0000-\u001f]/g,' ').trim();
function distinct(items){
  const seen=new Set(),output=[];
  for(const c of items){
    if(!c.rect||!Number.isFinite(c.rect.x)||!Number.isFinite(c.rect.y))continue;
    const key=[Math.round(c.rect.x*100),Math.round(c.rect.y*100),bestString(c.label).toLowerCase()].join('|');
    if(seen.has(key))continue;seen.add(key);
    output.push({id:`c${output.length}`,label:bestString(c.label||c.path?.split('/').at(-1)||'Button'),source:c.source||'dom',
      confidence:c.confidence||0.65,role:c.role||'button',rect:c.rect,...(c.path?{path:c.path}:{} )});
    if(output.length>=220)break;
  }
  return normalizeCandidates(output);
}
function validMode(mode){return ['structured','hybrid','visual'].includes(mode);}
export function frameSummary(result,{forceImage=false}={}){
  const state=result.state||'UNKNOWN';
  // Some runtimes expose controls behind their intro. They are not actionable until the overlay is dismissed.
  const raw=state==='INTRO'? (result.candidates||[]).filter(c=>/IntroScreen|\b(start|play|skip intro)\b/i.test(`${c.path||''} ${c.label||''}`)) : (result.candidates||[]);
  const candidates=distinct(raw);
  const mode=inferMode({state,candidates,opaqueCanvas:result.opaqueCanvas,forceImage});
  return {state,mode,adapter:result.adapter||'generic-dom',adapterVersion:result.adapterVersion||'1',candidates,
    metadata:{opaqueCanvas:!!result.opaqueCanvas,extractedControls:candidates.length,
      ...(['loading','active','spinning','choice','awaiting_start','awaiting_confirmation','result','idle','blocked'].includes(result.roundPhase)?{roundPhase:result.roundPhase}:{}),
      ...(result.blockedReason==='session-expired'?{blockedReason:result.blockedReason}:{})}};
}
// Optional adapter registry. Adding providers does not require changing cloud schema or MCP.
export async function extractFromFrame(frame,{provider='unknown',forceImage=false}={}){
  let selected=null;
  if(provider==='pragmatic'||provider==='unknown'){
    try{const data=await frame.evaluate(inspectPragmatic);if(data?.supported)selected=data;}catch{}
  }
  if(!selected){
    try{selected=await frame.evaluate(inspectDOM);}catch{selected={adapter:'opaque-canvas',state:'UNKNOWN',opaqueCanvas:true,candidates:[]};}
  }
  return frameSummary(selected,{forceImage});
}
export function adapterHelp(){return {
  'pragmatic':'read-only Unity/XTButton runtime extractor',
  'any-html':'generic DOM buttons, ARIA roles, links, toggles and menu items',
  'playtech,3oaks,rubyplay,belatra,unknown':'generic DOM if accessible, screenshot fallback for opaque canvas',
  'playngo,amusnet,netent,pgsoft':'generic DOM if accessible, screenshot fallback for opaque canvas; no validated provider runtime',
  add:'Implement an inspect function for the provider, register it in extractFromFrame, preserve normalized rects.'
};}
