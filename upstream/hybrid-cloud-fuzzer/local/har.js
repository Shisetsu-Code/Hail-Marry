// Bounded, sanitized HAR 1.2 diagnostics for PUBLIC DEMOS only.
// Captures endpoint/action shapes, never cookies, credentials or raw private payloads.
// HARs remain local; the normal Cloudflare synchronizer does not upload them.
import fs from 'node:fs/promises';
import path from 'node:path';

const SECRET=/(?:auth|bearer|token|cookie|session|password|passwd|secret|api[_-]?key|private|credential|account|user[_-]?id|email|phone|address|fingerprint|signature|nonce|jwt|access[_-]?key|refresh[_-]?key|client[_-]?secret|device[_-]?id|creditcard|card[_-]?number)/i;
const REDACTED='[REDACTED]';
const textLimit=4096;
const safeString=value=>typeof value==='string'&&value.length<=80&&/^[\w .,:+\-/]{0,80}$/.test(value)&&!/[a-f0-9]{28,}/i.test(value)&&!/[A-Za-z0-9+/=_-]{36,}/.test(value);
function cleanScalar(value,key=''){
  if(SECRET.test(key))return REDACTED;
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:REDACTED;
  if(typeof value==='string')return safeString(value)?value:REDACTED;
  return REDACTED;
}
export function scrub(value,key='',depth=0){
  if(SECRET.test(key))return REDACTED;
  if(depth>5)return '[TRUNCATED]';
  if(Array.isArray(value))return value.slice(0,30).map(v=>scrub(v,'',depth+1));
  if(value&&typeof value==='object'){
    const output={};for(const [k,v] of Object.entries(value).slice(0,80))output[k.slice(0,80)]=scrub(v,k,depth+1);
    return output;
  }
  return cleanScalar(value,key);
}
export function sanitizeUrl(value){
  try{
    const u=new URL(value);
    if(!['http:','https:','ws:','wss:'].includes(u.protocol))return '[NON_HTTP_URL]';
    u.username='';u.password='';u.hash='';
    u.pathname=u.pathname.split('/').map(s=>s.length>45||/[a-f0-9]{28,}/i.test(s)?REDACTED:s).join('/');
    for(const [key,val] of [...u.searchParams.entries()])u.searchParams.set(key,String(cleanScalar(val,key)));
    return u.toString().slice(0,1400);
  }catch{return '[INVALID_URL]';}
}
export function sanitizePayload(raw,mime=''){
  if(typeof raw!=='string'||!raw)return null;
  if(raw.length>50000)return '[BODY_TOO_LARGE]';
  const content=String(mime).toLowerCase();
  if(content.includes('json')||/^\s*[\[{]/.test(raw)){
    try{return JSON.stringify(scrub(JSON.parse(raw))).slice(0,textLimit);}catch{}
  }
  if(content.includes('form-urlencoded')||/^[\w.-]+=[^\n]*(?:&[\w.-]+=|$)/.test(raw)){
    try{const params=new URLSearchParams(raw),out=new URLSearchParams();let i=0;
      for(const [key,val] of params){if(i++>=70)break;out.append(key.slice(0,80),String(cleanScalar(val,key)));}
      return out.toString().slice(0,textLimit);
    }catch{}
  }
  return safeString(raw)?raw.slice(0,textLimit):'[OPAQUE_OR_SENSITIVE_BODY]';
}
const safeHeader=headers=>{
  const value=typeof headers==='object'&&headers?headers['content-type']||headers['Content-Type']:null;
  return value&&typeof value==='string'?[{name:'content-type',value:value.split(';')[0].trim().slice(0,100)}]:[];
};
export function validateHarMode(mode){
  if(!['off','fallback','all'].includes(mode))throw Error('har must be off, fallback or all');
  return mode;
}
export function shouldSaveHar(mode,screenMode,state){
  validateHarMode(mode);
  return mode==='all'||mode==='fallback'&&(screenMode!=='structured'||state==='INTRO'||state==='UNKNOWN');
}
export function summarizeHar(har){
  const entries=har.log.entries||[],ws=har.log._webSockets||[];
  const urls=new Map();const actions=new Map();
  for(const e of entries){
    try{const u=new URL(e.request.url);const route=e.request.method+' '+u.hostname+u.pathname;
      urls.set(route,(urls.get(route)||0)+1);
      const q=u.searchParams.get('action')||u.searchParams.get('cmd')||u.searchParams.get('op');
      if(q&&q!==REDACTED)actions.set(q,(actions.get(q)||0)+1);
    }catch{}
    const data=e.request.postData?.text||'';
    try{const v=data.startsWith('{')?JSON.parse(data):Object.fromEntries(new URLSearchParams(data));
      const action=v.action||v.cmd||v.command||v.op||v.type;
      if(typeof action==='string'&&safeString(action))actions.set(action,(actions.get(action)||0)+1);
    }catch{}
  }
  for(const frame of ws){try{const data=JSON.parse(frame.payload);
    const action=data.action||data.cmd||data.command||data.op||data.type;
    if(typeof action==='string'&&safeString(action))actions.set(action,(actions.get(action)||0)+1);
  }catch{}}
  return {requests:entries.length,webSocketFrames:ws.length,uniqueEndpoints:urls.size,
    endpoints:[...urls].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([route,count])=>({route,count})),
    actions:[...actions].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([name,count])=>({name,count})),
    truncated:Boolean(har.log._truncated)};
}

export function createNetworkRecorder(context,{maxEntries=350,maxFrames=150,bodyLimit=12000,urlFilter=()=>true}={}){
  if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>2000)throw Error('maxEntries out of range');
  const entries=[],wsFrames=[],pending=new Set(),requestEntries=new WeakMap();
  let stopped=false,truncated=false;
  const onRequest=req=>{
    if(stopped)return;
    if(entries.length>=maxEntries){truncated=true;return;}
    const url=sanitizeUrl(req.url());if(url.startsWith('[')||!urlFilter(url))return;
    const headers=req.headers?.()||{};
    let post=null;try{post=sanitizePayload(req.postData?.(),headers['content-type']||'');}catch{}
    const e={startedDateTime:new Date().toISOString(),time:0,request:{method:req.method(),url,httpVersion:'HTTP/1.1',headers:safeHeader(headers),queryString:[],cookies:[],headersSize:-1,bodySize:-1,...(post?{postData:{mimeType:headers['content-type']||'',text:post}}:{})},
      response:{status:0,statusText:'',httpVersion:'HTTP/1.1',headers:[],cookies:[],content:{size:0,mimeType:''},redirectURL:'',headersSize:-1,bodySize:-1},cache:{},timings:{send:0,wait:0,receive:0}};
    entries.push(e);requestEntries.set(req,e);
  };
  const onResponse=res=>{
    if(stopped)return;
    const entry=requestEntries.get(res.request());if(!entry)return;
    const task=(async()=>{
      try{
        const headers=res.headers?.()||{},mime=headers['content-type']||'';
        entry.response.status=res.status();entry.response.statusText=res.statusText?.()||'';
        entry.response.headers=safeHeader(headers);entry.response.content.mimeType=mime.slice(0,120);
        const length=Number(headers['content-length']||0);
        if((mime.includes('json')||mime.includes('text/plain')||mime.includes('form-urlencoded'))&&(!length||length<=bodyLimit)){
          const body=await res.body();if(body.length<=bodyLimit){
            const clean=sanitizePayload(body.toString('utf8'),mime);
            if(clean)entry.response.content.text=clean;
          }
        }
      }catch{};
    })();pending.add(task);task.finally(()=>pending.delete(task));
  };
  const onFailed=req=>{const entry=requestEntries.get(req);if(entry)entry._error='requestfailed';};
  const pageHandlers=new Map();
  const onPage=page=>{
    const onWS=socket=>{
      const url=sanitizeUrl(socket.url());
      if(!urlFilter(url))return;
      const record=direction=>event=>{
        if(stopped)return;
        if(wsFrames.length>=maxFrames){truncated=true;return;}
        const payload=typeof event.payload==='string'?sanitizePayload(event.payload,'websocket'):'[BINARY_FRAME]';
        wsFrames.push({time:new Date().toISOString(),url,direction,payload});
      };
      socket.on('framesent',record('sent'));socket.on('framereceived',record('received'));
    };
    page.on('websocket',onWS);pageHandlers.set(page,onWS);
  };
  context.on('request',onRequest);context.on('response',onResponse);context.on('requestfailed',onFailed);
  context.on('page',onPage);
  if(typeof context.pages==='function'){for(const page of context.pages())onPage(page);}
  else onPage(context); // Playwright Page can be used to record one tab only.
  return {
    async finish(){
      stopped=true;
      context.off?.('request',onRequest);context.off?.('response',onResponse);context.off?.('requestfailed',onFailed);context.off?.('page',onPage);
      for(const [page,handler] of pageHandlers)page.off?.('websocket',handler);
      await Promise.race([Promise.allSettled([...pending]),new Promise(resolve=>setTimeout(resolve,1800))]);
      const har={log:{version:'1.2',creator:{name:'Hybrid Cloud Fuzzer',version:'1'},pages:[],entries,
        _webSockets:wsFrames,_truncated:truncated,_notice:'Sanitized DEMO diagnostics. Credentials/cookies and raw scripts are excluded.'}};
      return {har,summary:summarizeHar(har)};
    }
  };
}
export async function saveSanitizedHar(file,har){
  await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(har,null,2)+'\n');await fs.rename(tmp,file);
}
