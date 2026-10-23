// Remote OAuth smoke check. The login key comes only from the environment.
// Creates a test client/grant and revokes that grant in finally; never prints tokens.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export async function verifyOAuth({url=process.env.HYBRID_FUZZER_URL,password=process.env.HYBRID_OAUTH_LOGIN_SECRET,onToken}={}){
 if(!password||!url?.startsWith('https://'))throw Error('HTTPS URL and private OAuth login key required');
 const base=new URL(url).origin,resource=base+'/mcp';
 const fetcher=(path,init={})=>fetch(new URL(path,base),{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});
 const metadata=await (await fetcher('/.well-known/oauth-authorization-server')).json();
 assert.ok(metadata.code_challenge_methods_supported.includes('S256'));assert.equal(metadata.issuer,base);assert.equal(metadata.client_id_metadata_document_supported,true);
 const protectedMetadata=await (await fetcher('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(protectedMetadata.resource,resource);
 const redirect='https://chatgpt.com/connector_platform/oauth/callback';
 const registered=await fetcher(metadata.registration_endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Hybrid deployment OAuth verification',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
 assert.equal(registered.status,201);const client=await registered.json();
 const verifier=randomBytes(48).toString('base64url'),state=randomBytes(24).toString('hex');
 const authorization=new URL(metadata.authorization_endpoint);authorization.search=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',resource,scope:'mcp offline_access',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
 const page=await fetcher(authorization);assert.equal(page.status,200);const html=await page.text();const handle=/name="handle" value="([^"]+)"/.exec(html)?.[1];assert.ok(handle);
 const cookie=page.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 const approved=await fetcher('/authorize',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,decision:'approve',password})});
 assert.equal(approved.status,302);const callback=new URL(approved.headers.get('location'));assert.equal(callback.searchParams.get('state'),state);assert.equal(callback.origin,'https://chatgpt.com');
 const tokenRequest=body=>fetcher(metadata.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...body,client_id:client.client_id,resource})});
 const exchange=await tokenRequest({grant_type:'authorization_code',code:callback.searchParams.get('code'),code_verifier:verifier,redirect_uri:redirect});assert.equal(exchange.status,200);
 let tokens=await exchange.json();
 try{
  const refreshed=await tokenRequest({grant_type:'refresh_token',refresh_token:tokens.refresh_token});assert.equal(refreshed.status,200);tokens=await refreshed.json();
  let id=0;
  const rpc=async(method,params={})=>{const r=await fetcher(resource,{method:'POST',headers:{Authorization:`Bearer ${tokens.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});assert.equal(r.status,200);return r.json();};
  assert.equal((await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'oauth-verification',version:'1'}})).result.serverInfo.name,'hybrid-cloud-fuzzer');
  assert.ok((await rpc('tools/list')).result.tools.some(t=>t.name==='save_and_next'));
  assert.ok(!(await rpc('tools/call',{name:'queue_stats',arguments:{}})).result.isError);
  assert.equal((await fetcher('/v1/stats',{headers:{Authorization:`Bearer ${tokens.access_token}`}})).status,401);
  if(onToken)await onToken(tokens.access_token);
 }finally{
  const revoked=await fetcher(metadata.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,token:tokens.refresh_token,token_type_hint:'refresh_token'})});assert.equal(revoked.status,200);
 }
 assert.equal((await fetcher(resource,{method:'POST',headers:{Authorization:`Bearer ${tokens.access_token}`}})).status,401);
 return {ok:true,oauth:true,pkce:'S256',refresh:true,revocation:true,mcp:true,apiIsolation:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await verifyOAuth()));}catch{console.error('OAuth verification failed (credentials and tokens hidden).');process.exitCode=1;}
}
