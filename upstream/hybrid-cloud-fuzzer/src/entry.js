import {OAuthProvider} from '@cloudflare/workers-oauth-provider';
import worker from './worker.js';
import {handleMcp} from './mcp.js';
import {authorize,equalSecret} from './oauth.js';

export default {
 async fetch(request,env,ctx){
  const path=new URL(request.url).pathname;
  // Existing operator integrations keep their independent static credential.
  if(path==='/mcp'&&await equalSecret(request.headers.get('Authorization')?.replace(/^Bearer /,''),env.MCP_TOKEN))return worker.fetch(request,env,ctx);
  const oauth=new OAuthProvider({
   apiRoute:'/mcp',
   apiHandler:{async fetch(req,bindings,context){
    if(new URL(req.url).pathname!=='/mcp')return new Response(null,{status:404});
    if(context.props?.userId!=='owner'||!context.auth?.scope.includes('mcp'))return new Response(null,{status:403});
    return handleMcp(req,bindings);
   }},
   defaultHandler:{fetch:(req,bindings,context)=>new URL(req.url).pathname==='/authorize'?authorize(req,bindings):worker.fetch(req,bindings,context)},
   authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',
   scopesSupported:['mcp','offline_access'],requiredScopes:['mcp'],
   resourceMetadata:{resource:env.OAUTH_ISSUER+'/mcp',authorization_servers:[env.OAUTH_ISSUER]},
   clientIdMetadataDocumentEnabled:true,
   accessTokenTTL:3600,refreshTokenTTL:2592000
  });
  return oauth.fetch(request,env,ctx);
 }
};
