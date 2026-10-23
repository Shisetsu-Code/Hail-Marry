// Explicit, opt-in network-only reproduction of *public DEMO* HTTP evidence.
// No automatic retries, credential capture, real-money wagering or WebSocket invention.
const dangerous=/\[REDACTED\]|\[OPAQUE_OR_SENSITIVE_BODY\]|\[BODY_TOO_LARGE\]|\[TRUNCATED\]/i;
const restricted=/(?:\b(?:account|deposit|withdraw|payment|cashout|wallet|realmoney)\b)/i;
export function prepareReplay(har,{allowedOrigins=[]}={}){
 if(!Array.isArray(allowedOrigins)||!allowedOrigins.length)throw Error('explicit allowedOrigins required');
 const origins=new Set(allowedOrigins.map(v=>new URL(v).origin));
 const commands=[];
 for(const e of har?.log?.entries||[]){
  if(!['POST','GET','PUT','PATCH','DELETE'].includes(e.request?.method))continue;
  const u=new URL(e.request.url);
  if(u.protocol!=='https:'||!origins.has(u.origin))throw Error('request origin not approved');
  if(restricted.test(u.href))throw Error('account/payment endpoint not approved');
  const payload=e.request?.postData?.text??null;
  if(dangerous.test(u.href)||dangerous.test(payload||'')||dangerous.test(decodeURIComponent(payload||'')))throw Error('redacted or sensitive values require fresh demo-session bindings');
  const contentType=e.request?.postData?.mimeType||e.request?.headers?.find(h=>h.name.toLowerCase()==='content-type')?.value||'application/x-www-form-urlencoded';
  commands.push({method:e.request.method,url:u.href,body:payload,contentType});
 }
 return commands;
}
export async function replayTrace(har,{allowedOrigins,allowMutating=false,fetcher=fetch}={}){
 const commands=prepareReplay(har,{allowedOrigins});
 if(commands.some(c=>!['GET','HEAD'].includes(c.method))&&!allowMutating)throw Error('allowMutating=true required to reproduce demo actions');
 const results=[];
 for(const c of commands){
  // Do not redirect to a different origin, attach account cookies or retry mutating requests.
  const options={method:c.method,redirect:'manual',headers:{...(c.body!==null?{'Content-Type':c.contentType}:{})},...(c.body!==null?{body:c.body}:{}),signal:AbortSignal.timeout(15000)};
  const r=await fetcher(c.url,options);
  if(r.status>=300&&r.status<400)throw Error('redirect rejected during replay');
  results.push({url:c.url,method:c.method,status:r.status,ok:r.ok});
  if(!r.ok)break;
 }
 return results;
}
