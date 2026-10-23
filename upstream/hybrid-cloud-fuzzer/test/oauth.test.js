import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Response as TestResponse} from 'miniflare';

const origin='https://hybrid-cloud-fuzzer.braian-n-l.workers.dev';
const resource=origin+'/mcp', password='owner-login-secret-for-tests-only';
let mf;
before(async()=>{
 const config=await readFile(new URL('../wrangler.toml',import.meta.url),'utf8');
 const entry=/^main\s*=\s*"([^"]+)"/m.exec(config)[1];
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../'+entry,import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['module','main'],external:['cloudflare:workers'],conditions:['workerd','worker','browser']});
 const outboundService=async req=>{
  const url=new URL(req.url);
  if(url.hostname==='cimd.example')return new TestResponse(JSON.stringify({client_id:'https://cimd.example/client.json',client_name:'CIMD test',redirect_uris:['https://chatgpt.com/connector_platform/oauth/callback'],token_endpoint_auth_method:'private_key_jwt',token_endpoint_auth_methods_supported:['none','private_key_jwt'],jwks_uri:'https://cimd.example/jwks.json'}),{headers:{'Content-Type':'application/json'}});
  return new TestResponse('Unexpected outbound fetch',{status:404});
 };
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],d1Databases:['DB'],r2Buckets:['IMAGES'],bindings:{MCP_TOKEN:'legacy-mcp',INGEST_TOKEN:'ingest',REVIEW_TOKEN:'review',OAUTH_LOGIN_SECRET:password,OAUTH_ISSUER:origin},outboundService}));
 await mf.ready;
 const db=await mf.getD1Database('DB');
 for(const sql of ((await readFile(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'))+'\n'+(await readFile(new URL('../migrations/0002_action_traces.sql',import.meta.url),'utf8'))).replace(/^--.*$/gm,'').split(';').filter(x=>x.trim()))await db.prepare(sql).run();
});
after(async()=>{await mf?.dispose();});
const req=(path,init={})=>mf.dispatchFetch(origin+path,{...init,redirect:'manual'});
async function client(name='ChatGPT test'){
 const r=await req('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:name,redirect_uris:['https://chatgpt.com/connector_platform/oauth/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
 assert.equal(r.status,201);return r.json();
}
async function consent(c,extra={}){
 const verifier='a'.repeat(64),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
 const challenge=Buffer.from(digest).toString('base64url');
 const query=new URLSearchParams({client_id:c.client_id,redirect_uri:c.redirect_uris[0],response_type:'code',scope:'mcp offline_access',resource,state:'test-state',code_challenge:challenge,code_challenge_method:'S256',...extra});
 const r=await req('/authorize?'+query);const html=await r.text();
 return {r,html,handle:/name="handle" value="([^"]+)"/.exec(html)?.[1],cookie:r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),verifier};
}
const approve=(flow,secret=password,headers={})=>req('/authorize',{method:'POST',headers:{Origin:origin,Cookie:flow.cookie,'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({handle:flow.handle,decision:'approve',password:secret})});
async function token(c,code,verifier){return req('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:c.client_id,redirect_uri:c.redirect_uris[0],code,code_verifier:verifier,resource})});}
test('OAuth discovery advertises PKCE, registration, and protected MCP resource',async()=>{
 const r=await req('/.well-known/oauth-authorization-server');assert.equal(r.status,200);
 const meta=await r.json();assert.ok(meta.code_challenge_methods_supported.includes('S256'));assert.equal(meta.issuer,origin);assert.ok(meta.client_id_metadata_document_supported);
 const protectedMeta=await (await req('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(protectedMeta.resource,resource);
 const unauthorized=await req('/mcp',{method:'POST'});assert.equal(unauthorized.status,401);assert.match(unauthorized.headers.get('www-authenticate'),/resource_metadata=/);
});
test('Owner consent issues working MCP tokens, refreshes and revokes access',async()=>{
 const c=await client(),flow=await consent(c);assert.equal(flow.r.status,200);assert.ok(flow.handle);assert.match(flow.html,/chatgpt.com/);assert.match(flow.r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 const approved=await approve(flow);assert.equal(approved.status,302);const callback=new URL(approved.headers.get('location'));assert.equal(callback.searchParams.get('state'),'test-state');assert.equal(callback.origin,'https://chatgpt.com');
 const exchange=await token(c,callback.searchParams.get('code'),flow.verifier);assert.equal(exchange.status,200);const tokens=await exchange.json();assert.ok(tokens.refresh_token);
 const list=await req('/mcp',{method:'POST',headers:{Authorization:`Bearer ${tokens.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(list.status,200);assert.ok((await list.json()).result.tools.some(t=>t.name==='save_and_next'));
 const refreshed=await req('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:c.client_id,resource})});assert.equal(refreshed.status,200);const renewed=await refreshed.json();assert.ok(renewed.access_token);
 const metadata=await (await req('/.well-known/oauth-authorization-server')).json();const revoked=await req(new URL(metadata.revocation_endpoint).pathname,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:renewed.refresh_token,token_type_hint:'refresh_token',client_id:c.client_id})});assert.equal(revoked.status,200);
 assert.equal((await req('/mcp',{method:'POST',headers:{Authorization:`Bearer ${renewed.access_token}`}})).status,401);
 assert.equal((await token(c,callback.searchParams.get('code'),flow.verifier)).status,400);
});
test('Consent denies wrong password, cross-site POST and stolen browser handle',async()=>{
 const c=await client(),flow=await consent(c);
 assert.equal((await approve(flow,'wrong')).status,401);
 assert.equal((await approve(flow,password,{Origin:'https://evil.example'})).status,403);
 assert.equal((await approve(flow,password,{Cookie:''})).status,400);
 assert.equal((await approve(flow,password,{Origin:'null'})).status,403);
});
test('Native form submission keeps the browser Origin instead of tainting it through Referrer-Policy',async()=>{
 const c=await client(),flow=await consent(c);
 // HTML form POSTs are non-CORS requests. Fetch's origin serialization returns
 // null under no-referrer, even when the form posts to its own origin.
 const policy=flow.r.headers.get('referrer-policy');
 const browserOrigin=policy==='no-referrer'?'null':origin;
 const approved=await approve(flow,password,{Origin:browserOrigin});
 assert.equal(approved.status,302,'The served page must allow its own native browser form POST');
});
test('Browser form CSP allows the validated OAuth callback redirect and no unrelated host',async()=>{
 const c=await client(),flow=await consent(c);
 const formAction=flow.r.headers.get('content-security-policy').split(';').map(s=>s.trim()).find(s=>s.startsWith('form-action '));
 const allowed=formAction.split(/\s+/).slice(1);
 assert.deepEqual(allowed,["'self'",new URL(c.redirect_uris[0]).origin]);
 assert.ok(!allowed.includes('*'));assert.ok(!allowed.includes('https://evil.example'));
});
test('OAuth rejects redirect substitution, missing PKCE, unsupported scopes and mismatched verifier',async()=>{
 const c=await client();assert.notEqual((await consent(c,{redirect_uri:'https://evil.example/callback'})).r.status,200);
 assert.notEqual((await consent(c,{code_challenge:'',code_challenge_method:''})).r.status,200);
 const scopes=await consent(c,{scope:'admin'});assert.notEqual(scopes.r.status,200);
 const flow=await consent(c);const approved=await approve(flow);const code=new URL(approved.headers.get('location')).searchParams.get('code');assert.equal((await token(c,code,'b'.repeat(64))).status,400);
});
test('Consent escapes client metadata and denial returns access_denied',async()=>{
 const c=await client('<script>alert(1)</script>');const flow=await consent(c);assert.ok(!flow.html.includes('<script>alert(1)</script>'));
 const denied=await req('/authorize',{method:'POST',headers:{Origin:origin,Cookie:flow.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle:flow.handle,decision:'deny'})});assert.equal(denied.status,302);assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'),'access_denied');
});
test('Legacy MCP bearer and ingest/review auth remain independent',async()=>{
 const r=await req('/mcp',{method:'POST',headers:{Authorization:'Bearer legacy-mcp','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})});assert.equal((await r.json()).result.serverInfo.name,'hybrid-cloud-fuzzer');
 assert.equal((await req('/v1/stats',{headers:{Authorization:'Bearer legacy-mcp'}})).status,401);
 assert.equal((await req('/v1/stats',{headers:{Authorization:'Bearer review'}})).status,200);
});
test('CIMD resolves client metadata, negotiates public PKCE and rejects mismatched identity/redirect',async()=>{
 const c={client_id:'https://cimd.example/client.json',redirect_uris:['https://chatgpt.com/connector_platform/oauth/callback']};
 const flow=await consent(c);assert.equal(flow.r.status,200);assert.match(flow.html,/cimd.example/);
 const approved=await approve(flow);assert.equal(approved.status,302);const code=new URL(approved.headers.get('location')).searchParams.get('code');
 const exchange=await token(c,code,flow.verifier);assert.equal(exchange.status,200);const tokens=await exchange.json();
 const r=await req('/mcp',{method:'POST',headers:{Authorization:`Bearer ${tokens.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(r.status,200);assert.ok((await r.json()).result.tools.some(t=>t.name==='save_and_next'));
 assert.notEqual((await consent({...c,client_id:'https://cimd.example/wrong-client.json'})).r.status,200);
 assert.notEqual((await consent(c,{redirect_uri:'https://evil.example/callback'})).r.status,200);
});
