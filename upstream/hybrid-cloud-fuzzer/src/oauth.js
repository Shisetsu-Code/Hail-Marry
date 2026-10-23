import {AuthorizationError,CimdFetchError} from '@cloudflare/workers-oauth-provider';

const scopes=['mcp','offline_access'];
const escape=value=>String(value).replace(/[&<>"']/g,char=>`&#${char.charCodeAt(0)};`);
const headers={
 // Native form POSTs serialize Origin as null under no-referrer. Keep the
 // same-origin Origin while suppressing referrers to the OAuth callback host.
 'Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff',
 'X-Frame-Options':'DENY',
 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};
function response(message,status=400){return new Response(message,{status,headers:{...headers,'Content-Type':'text/plain; charset=utf-8'}});}
export async function equalSecret(value,secret){
 if(typeof value!=='string'||typeof secret!=='string'||!value||!secret||value.length>1024)return false;
 const digest=async text=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
 const [a,b]=await Promise.all([digest(value),digest(secret)]);let diff=0;
 for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
function page(details,handle){
 return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conectar Hybrid Cloud Fuzzer</title><style>body{font:17px system-ui;max-width:580px;margin:8vh auto;padding:24px;color:#16202b;background:#f6f8fa}main{background:white;padding:28px;border:1px solid #ddd;border-radius:12px}input{box-sizing:border-box;width:100%;padding:12px;margin:10px 0 20px}button{padding:12px 20px;margin-right:10px;cursor:pointer}small{display:block;margin-top:20px;line-height:1.5}</style><main>
<h1>Conectar Hybrid Cloud Fuzzer</h1><p><strong>${escape(details.clientName)}</strong> solicita acceso a la cola de revisión y a sus clasificaciones.</p>
<p>${details.clientDomain?`Dominio del cliente: <strong>${escape(details.clientDomain)}</strong>.`:'El nombre del cliente fue declarado por la propia aplicación.'}</p>
<p>El acceso se enviará a <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback?'<p>Este acceso se enviará a una aplicación de tu computadora. Continuá solo si acabás de iniciar la conexión.</p>':''}
<p>Permisos: ${details.scope.includes('mcp')?'consultar elementos y guardar clasificaciones':''}${details.scope.includes('offline_access')?'; renovar la conexión sin volver a ingresar la clave':''}.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
<label for="password">Clave privada de conexión</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024">
<button name="decision" value="approve">Autorizar</button><button name="decision" value="deny">Cancelar</button></form>
<small>Ingresá la clave de conexión entregada por el operador. No es tu contraseña de ChatGPT ni de Cloudflare. Este permiso permite clasificar; no ejecuta clicks ni compras.</small></main></html>`;
}
export async function authorize(request,env){
 if(!env.OAUTH_LOGIN_SECRET||env.OAUTH_LOGIN_SECRET.length<32)return response('El acceso OAuth aún no está configurado.',503);
 const oauth=env.OAUTH_PROVIDER;
 try{
  if(request.method==='GET'){
   const authRequest=await oauth.parseAuthRequest(request);
   if(!authRequest.scope.length)authRequest.scope=['mcp','offline_access'];
   if(!authRequest.scope.includes('mcp')||authRequest.scope.some(s=>!scopes.includes(s)))return response('Permisos solicitados no admitidos.');
   const details=await oauth.describeConsent(authRequest),consent=await oauth.beginConsent(authRequest);
   for(const [name,value] of Object.entries(headers))consent.headers.set(name,value);
   // Chromium applies form-action to redirects too. The provider has already
   // validated this exact registered redirect URI; permit only its origin.
   const callbackOrigin=new URL(authRequest.redirectUri).origin;
   consent.headers.set('Content-Security-Policy',headers['Content-Security-Policy'].replace("form-action 'self'",`form-action 'self' ${callbackOrigin}`));
   consent.headers.set('Content-Type','text/html; charset=utf-8');
   return new Response(page(details,consent.handle),{headers:consent.headers});
  }
  if(request.method!=='POST')return response('Método no admitido.',405);
  if(request.headers.get('Origin')!==env.OAUTH_ISSUER)return response('Origen no permitido.',403);
  if(!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded'))return response('Formato no admitido.',415);
  if(Number(request.headers.get('Content-Length'))>8192)return response('Solicitud demasiado grande.',413);
  const body=await request.text();if(body.length>8192)return response('Solicitud demasiado grande.',413);
  const form=new URLSearchParams(body),handle=form.get('handle');
  if(form.get('decision')==='deny'){
   const denied=await oauth.denyConsent(request,handle);return new Response(null,{status:302,headers:denied.headers});
  }
  if(form.get('decision')!=='approve')return response('Decisión no válida.');
  if(!await equalSecret(form.get('password'),env.OAUTH_LOGIN_SECRET))return response('Clave incorrecta. Volvé a iniciar la conexión.',401);
  const approved=await oauth.approveConsent(request,handle);
  if(!approved.request.scope.includes('mcp'))return response('Permisos insuficientes.',403);
  const {redirectTo}=await oauth.completeAuthorization({request:approved.request,userId:'owner',metadata:{label:'Hybrid Fuzzer operator'},scope:approved.request.scope,props:{userId:'owner'}});
  approved.headers.set('Location',redirectTo);approved.headers.set('Cache-Control','no-store');
  return new Response(null,{status:302,headers:approved.headers});
 }catch(error){
  if(error instanceof AuthorizationError||error instanceof CimdFetchError)return response('La autorización no es válida o expiró. Volvé a iniciar la conexión.');
  throw error;
 }
}
