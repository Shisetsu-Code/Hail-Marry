// Shared contract between local extractors, Cloudflare and MCP.
const safeId=/^[a-z0-9][a-z0-9_.-]{0,99}$/i;
const kinds=new Set(['buy','navigate','pick','other']);
const modes=new Set(['structured','hybrid','visual']);
const states=new Set(['BASE','INTRO','BUY_MENU','CONFIRM','BONUS','LOADING','UNKNOWN','OTHER']);
const sources=new Set(['runtime','dom','manual','provider']);
export class InputError extends Error { constructor(message,status=400){super(message);this.status=status;this.name='InputError';} }
export function requiredId(value,label){if(typeof value!=='string'||!safeId.test(value))throw new InputError(`invalid ${label}`);return value;}
export function rectOf(rect){
  if(!rect||typeof rect!=='object')throw new InputError('candidate rect required');
  const {x,y,w,h}=rect;
  for(const val of [x,y,w,h])if(typeof val!=='number'||!Number.isFinite(val))throw new InputError('non-numeric rectangle');
  if(x<0||x>1||y<0||y>1||w<=0||h<=0||w>1||h>1||x+w>1.00001||y+h>1.00001)throw new InputError('rectangle outside screenshot');
  return {x,y,w,h};
}
export function normalizeCandidates(input){
  if(!Array.isArray(input)||input.length>250)throw new InputError('candidate array must have <=250 entries');
  const seen=new Set();
  return input.map((c,i)=>{
    if(!c||typeof c!=='object')throw new InputError('invalid candidate');
    const id=requiredId(c.id,'candidate id');if(seen.has(id))throw new InputError(`duplicate candidate ${id}`);seen.add(id);
    if(!sources.has(c.source))throw new InputError('invalid candidate source');
    if(typeof c.label!=='string'||c.label.length>180)throw new InputError('invalid candidate label');
    if(c.path!=null&&(typeof c.path!=='string'||c.path.length>1000))throw new InputError('invalid control path');
    if(typeof c.confidence!=='number'||!Number.isFinite(c.confidence)||c.confidence<0||c.confidence>1)throw new InputError('invalid confidence');
    return {id,label:c.label,source:c.source,role:String(c.role||'button').slice(0,36),rect:rectOf(c.rect),confidence:c.confidence,
      ...(c.path?{path:c.path}:{})};
  });
}
export function inferMode({state='UNKNOWN',candidates=[],opaqueCanvas=false,forceImage=false}={}){
  if(forceImage)return 'visual';
  if(!states.has(state))throw new InputError('invalid screen state');
  if(state==='INTRO')return 'visual';
  const meaningful=candidates.filter(c=>c.confidence>=0.65&&/(buy|purchase|feature|bonus|ante|special bet|option|select|play|continue|start|free spins|respins|collect|gamble)/i.test(`${c.label} ${c.path||''}`));
  if(!candidates.length||!meaningful.length)return 'visual';
  // The provider may still be displaying an opaque overlay or loading scene.
  // One accessible page button is not proof that an unknown canvas is understood.
  if(state==='UNKNOWN'&&opaqueCanvas)return 'hybrid';
  if(opaqueCanvas&&meaningful.length<candidates.length)return 'hybrid';
  return 'structured';
}
export function validateItem(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new InputError('JSON object required');
  const runId=requiredId(raw.runId,'runId'),provider=requiredId(raw.provider,'provider'),gameId=requiredId(raw.gameId,'gameId'),shotId=requiredId(raw.shotId,'shotId');
  const state=raw.state||'UNKNOWN', mode=raw.mode||'visual';
  if(!states.has(state)||!modes.has(mode))throw new InputError('invalid state/mode');
  const adapter=requiredId(raw.adapter||'generic','adapter');
  const adapterVersion=String(raw.adapterVersion||'1');if(adapterVersion.length>40)throw new InputError('invalid adapterVersion');
  const candidates=normalizeCandidates(raw.candidates||[]);
  if(mode==='structured'&&!candidates.length)throw new InputError('structured mode needs candidates');
  let width=raw.width??null,height=raw.height??null;
  for(const val of [width,height])if(val!==null&&(!Number.isSafeInteger(val)||val<1||val>20000))throw new InputError('invalid dimensions');
  if(raw.metadata!=null&&(typeof raw.metadata!=='object'||Array.isArray(raw.metadata)))throw new InputError('invalid metadata');
  const metadata={...(raw.metadata||{})};
  if(JSON.stringify(metadata).length>50_000)throw new InputError('metadata too large',413);
  return {id:`${runId}:${provider}:${gameId}:${shotId}`,runId,provider,gameId,shotId,state,mode,adapter,adapterVersion,candidates,width,height,metadata};
}
export function normalizeDecisions(input,candidates){
  const allowed=new Map(candidates.map(c=>[c.id,c]));
  const selections=input.selections??[],marks=input.marks??[];
  if(!Array.isArray(selections)||!Array.isArray(marks)||selections.length+marks.length>40)throw new InputError('max 40 selections/marks');
  const used=new Set();
  const selected=selections.map(value=>{
    if(!value||typeof value!=='object')throw new InputError('invalid selection');
    const item=allowed.get(value.candidateId);if(!item)throw new InputError('candidate no longer exists');
    if(used.has(item.id))throw new InputError('duplicate selection');used.add(item.id);
    if(!kinds.has(value.kind))throw new InputError('invalid action kind');
    const {x,y,w,h}=item.rect;
    return {candidateId:item.id,kind:value.kind,label:item.label,x:Number((x+w/2).toFixed(6)),y:Number((y+h/2).toFixed(6))};
  });
  const manual=marks.map(v=>{
    if(!v||typeof v!=='object'||!kinds.has(v.kind)||typeof v.label!=='string'||v.label.length>140)throw new InputError('invalid visual mark');
    if(!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.x<0||v.x>1||v.y<0||v.y>1)throw new InputError('visual mark must be normalized');
    return {x:v.x,y:v.y,kind:v.kind,label:v.label};
  });
  return {selections:selected,marks:manual,allMarks:[...selected.map(({x,y,kind,label})=>({x,y,kind,label})),...manual]};
}
