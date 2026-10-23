import {InputError,ingest,claim,save,release,rawItem,publicItem,stats,gameBlockers,decisionsFeed} from './core.js';
import {handleMcp} from './mcp.js';
import {recordTrace,retrieveTrace} from './traces.js';
import {enqueueWork,claimWork,renewWork,finishWork,deferWork,agentHeartbeat,workforceStats} from './workforce.js';
import {setProviderPolicy,providerPolicies,acquireProviderSession,renewProviderSession,releaseProviderSession,providerWorkload} from './provider-pacing.js';
import {progressReport} from './progress.js';
import {branchExecutions,claimBranch,finishBranch} from './branches.js';
import {storeValidation,listValidations,validationPreview,validationReference} from './capture-validation.js';
import {stageCapture,captureTiming,takeCaptureCommand,reviewRow,captureReviewPlan} from './capture-review.js';

function eqSecret(a,b){
  if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;
  let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);
  return diff===0;
}
function authorized(req,secret){const value=req.headers.get('Authorization')||'';return value.startsWith('Bearer ')&&eqSecret(value.slice(7),secret);}
function json(value,status=200,extra={}){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});}
function reject(){return json({error:'unauthorized'},401,{'WWW-Authenticate':'Bearer'});}
async function readJSON(req){
  if(Number(req.headers.get('Content-Length'))>512000)throw new InputError('request too large',413);
  let payload;try{payload=await req.json();}catch{throw new InputError('invalid JSON');}
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||JSON.stringify(payload).length>512000)throw new InputError('invalid JSON object or payload too large');
  return payload;
}
async function upload(req,env){
  if(Number(req.headers.get('Content-Length'))>9*1024*1024)throw new InputError('image payload too large',413);
  const mime=req.headers.get('Content-Type')||'';
  if(mime.startsWith('multipart/form-data')){
    const form=await req.formData();
    let payload;try{payload=JSON.parse(form.get('metadata'));}catch{throw new InputError('invalid metadata JSON');}
    const raw=form.get('image');if(!raw||typeof raw.arrayBuffer!=='function')throw new InputError('image required');
    if(raw.size>8*1024*1024)throw new InputError('JPEG too large',413);
    return json({item:await ingest(env,payload,await raw.arrayBuffer(),{replace:form.get('replace')==='true'})},201);
  }
  if(mime.includes('application/json')){
    const payload=await readJSON(req);
    return json({item:await ingest(env,payload,null,{replace:payload.replace===true})},201);
  }
  throw new InputError('use JSON or multipart/form-data',415);
}
export default {
  async fetch(request,env){
    try{
      const url=new URL(request.url),p=url.pathname;
      if(request.method==='GET'&&p==='/health'){
        try{if(!env.DB||!env.IMAGES)throw Error('bindings absent');let schema=await env.DB.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('items','decision_history','action_traces')").first();
          // Recover from a Worker publish that preceded the additive D1 migration.
          // Compatible with migrations/0002_action_traces.sql; no existing rows are altered.
          if(Number(schema?.count)===2){
            const base=await env.DB.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('items','decision_history')").first();
            if(Number(base?.count)===2){
              await env.DB.prepare("CREATE TABLE IF NOT EXISTS action_traces (trace_id TEXT PRIMARY KEY,parent_item_id TEXT NOT NULL REFERENCES items(id),child_item_id TEXT NOT NULL REFERENCES items(id),parent_source_sha256 TEXT NOT NULL,parent_revision INTEGER NOT NULL,storage_key TEXT NOT NULL,content_sha256 TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
              await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_action_traces_parent ON action_traces(parent_item_id)').run();
              schema=await env.DB.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('items','decision_history','action_traces')").first();
            }
          }
          if(Number(schema?.count)!==3)throw Error('D1 migration missing');
          const workforce=await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('workforce_jobs','workforce_agents')").first();
          const workforceReady=Number(workforce?.n)===2;
          const pacing=await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('provider_policies','provider_sessions')").first();
          const pacingReady=Number(pacing?.n)===2;
          const branches=await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='branch_executions'").first();
          const review=await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('capture_reviews','capture_timings')").first();
          return json({asyncCaptureReviewReady:Number(review?.n)===2,captureReviewReady:Number(review?.n)===2,captureValidationReady:true,branchTransitionsVersion:1,branchCoordinationReady:Number(branches?.n)===1,ok:true,service:'hybrid-cloud-fuzzer',schemaVersion:pacingReady?4:workforceReady?3:2,workforceReady,pacingReady,storage:'R2',database:'D1',mcp:'/mcp'});}
        catch{return json({ok:false,error:'D1/R2 not ready'},503);}
      }
      if(p==='/mcp')return authorized(request,env.MCP_TOKEN)?await handleMcp(request,env):reject();
      if(p==='/v1/capture-reviews'&&request.method==='POST'){
        if(!authorized(request,env.INGEST_TOKEN))return reject();
        if(Number(request.headers.get('Content-Length'))>9*1024*1024)throw new InputError('capture too large',413);
        const form=await request.formData();let data;try{data=JSON.parse(form.get('metadata'));}catch{throw new InputError('invalid metadata');}
        const image=form.get('image');if(!image||typeof image.arrayBuffer!=='function'||image.size>8*1024*1024)throw new InputError('bounded JPEG required');
        return json({review:await stageCapture(env,data,await image.arrayBuffer())},201);
      }
      if(p==='/v1/capture-reviews/command'&&request.method==='POST')return authorized(request,env.INGEST_TOKEN)?json({review:await takeCaptureCommand(env,await readJSON(request))}):reject();
      if(p==='/v1/items'&&request.method==='POST')return authorized(request,env.INGEST_TOKEN)?await upload(request,env):reject();
      if(p==='/v1/traces'&&request.method==='POST')return authorized(request,env.INGEST_TOKEN)?json(await recordTrace(env,await readJSON(request)),201):reject();
      if(p==='/v1/items/batch'&&request.method==='POST'){
        if(!authorized(request,env.INGEST_TOKEN))return reject();
        const value=await readJSON(request);if(!Array.isArray(value.items)||!value.items.length||value.items.length>20)throw new InputError('1..20 items required');
        const items=[];for(const x of value.items)items.push(await ingest(env,x));
        return json({items},201);
      }
      if(p==='/v1/validation-reports'&&request.method==='POST'){
        if(!authorized(request,env.INGEST_TOKEN))return reject();
        if(Number(request.headers.get('Content-Length'))>9*1024*1024)throw new InputError('validation too large',413);
        const form=await request.formData();let report;try{report=JSON.parse(form.get('metadata'));}catch{throw new InputError('invalid validation JSON');}
        const image=form.get('image');if(!image||typeof image.arrayBuffer!=='function'||image.size>8*1024*1024)throw new InputError('validation JPEG required');
        return json({report:await storeValidation(env,report,await image.arrayBuffer())},201);
      }
      if(p.startsWith('/v1/')){
        if(!authorized(request,env.REVIEW_TOKEN))return reject();
        if(p.startsWith('/v1/capture-review-images/')&&request.method==='GET'){
          const row=await reviewRow(env,decodeURIComponent(p.slice('/v1/capture-review-images/'.length)));
          const hash=url.searchParams.get('sha256')||row.image_sha256;if(!/^[a-f0-9]{64}$/.test(hash)||![row.image_sha256,...JSON.parse(row.history_json).map(h=>h.imageSha256)].includes(hash))throw new InputError('unknown review image',404);const key=`capture-review/${row.run_id}/${row.provider}/${row.game_id}/${hash}.jpg`;
          const image=await env.IMAGES.get(key);if(!image)throw new InputError('review JPEG missing',404);
          return new Response(image.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Image-SHA256':hash}});
        }
        if(p.startsWith('/v1/capture-reviews/')&&request.method==='GET')return json({review:await captureReviewPlan(env,decodeURIComponent(p.slice('/v1/capture-reviews/'.length)))});
        if(p==='/v1/capture-timing'&&request.method==='GET')return json(await captureTiming(env,{provider:url.searchParams.get('provider'),gameId:url.searchParams.get('gameId')}));
        if(p==='/v1/validation-reports'&&request.method==='GET')return json(await listValidations(env,{runId:url.searchParams.get('runId'),cursor:url.searchParams.get('cursor')||'',limit:Number(url.searchParams.get('limit')||30)}));
        if(p==='/v1/validation-reference'&&request.method==='GET')return json(await validationReference(env,{provider:url.searchParams.get('provider'),gameId:url.searchParams.get('gameId')}));
        if(p.startsWith('/v1/validation-previews/')&&request.method==='GET'){
          const image=await validationPreview(env,p.slice('/v1/validation-previews/'.length));
          return new Response(image.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
        }
        if(p==='/v1/branches'&&request.method==='GET')return json(await branchExecutions(env,{runId:url.searchParams.get('runId'),after:url.searchParams.get('after')||''}));
        if(p==='/v1/branches/claim'&&request.method==='POST')return json(await claimBranch(env,await readJSON(request)));
        if(p==='/v1/branches/finish'&&request.method==='POST')return json(await finishBranch(env,await readJSON(request)));
        // Workforce scheduler: all mutating routes require the existing REVIEW token.
        // Only the local agents execute discovery or captures; the Worker leases tickets.
        if(p==='/v1/work/jobs'&&request.method==='POST')return json(await enqueueWork(env,await readJSON(request)),201);
        if(p==='/v1/work/claim'&&request.method==='POST')return json({job:await claimWork(env,await readJSON(request))});
        if(p==='/v1/work/renew'&&request.method==='POST')return json({job:await renewWork(env,await readJSON(request))});
        if(p==='/v1/work/finish'&&request.method==='POST')return json({job:await finishWork(env,await readJSON(request))});
        if(p==='/v1/work/defer'&&request.method==='POST')return json({job:await deferWork(env,await readJSON(request))});
        if(p==='/v1/work/agent'&&request.method==='POST')return json(await agentHeartbeat(env,await readJSON(request)));
        if(p==='/v1/work/stats'&&request.method==='GET')return json(await workforceStats(env,{runId:url.searchParams.get('runId')}));
        if(p==='/v1/work/provider/policy'&&request.method==='POST')return json({policy:await setProviderPolicy(env,await readJSON(request))});
        if(p==='/v1/work/provider/policies'&&request.method==='GET')return json(await providerPolicies(env));
        if(p==='/v1/work/provider/lease'&&request.method==='POST')return json(await acquireProviderSession(env,await readJSON(request)));
        if(p==='/v1/work/provider/renew'&&request.method==='POST')return json(await renewProviderSession(env,await readJSON(request)));
        if(p==='/v1/work/provider/release'&&request.method==='POST')return json(await releaseProviderSession(env,await readJSON(request)));
        if(p==='/v1/work/providers'&&request.method==='GET')return json(await providerWorkload(env,{runId:url.searchParams.get('runId')}));

        if(p==='/v1/claim'&&request.method==='POST')return json({item:await claim(env,await readJSON(request))});
        if(p==='/v1/save'&&request.method==='POST')return json({item:await save(env,await readJSON(request))});
        if(p==='/v1/release'&&request.method==='POST')return json({item:await release(env,await readJSON(request))});
        if(p==='/v1/stats'&&request.method==='GET')return json(await stats(env,{runId:url.searchParams.get('runId'),provider:url.searchParams.get('provider')}));
        if(p==='/v1/progress'&&request.method==='GET')return json(await progressReport(env,{runId:url.searchParams.get('runId')}));
        if(p==='/v1/game-blockers'&&request.method==='GET')return json(await gameBlockers(env,{runId:url.searchParams.get('runId'),after:url.searchParams.get('after')||'',limit:Number(url.searchParams.get('limit')||200)}));
        const traceMatch=/^\/v1\/traces\/([a-f0-9]{64})$/i.exec(p);
        if(traceMatch&&request.method==='GET')return json(await retrieveTrace(env,traceMatch[1]));
        if(p==='/v1/decisions'&&request.method==='GET')return json(await decisionsFeed(env,{runId:url.searchParams.get('runId'),after:Number(url.searchParams.get('after')||0),limit:Number(url.searchParams.get('limit')||50)}));
        const match=/^\/v1\/items\/([^/]+)(\/image)?$/.exec(p);
        if(match&&request.method==='GET'){
          const row=await rawItem(env,decodeURIComponent(match[1]));
          if(!match[2])return json({item:publicItem(row)});
          if(!row.image_key)throw new InputError('item has no image',404);
          const object=await env.IMAGES.get(row.image_key);if(!object)throw new InputError('JPEG absent',404);
          return new Response(object.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private,no-store','X-Image-SHA256':row.image_sha256,'X-Content-Type-Options':'nosniff'}});
        }
      }
      return json({error:'not found'},404);
    }catch(error){
      if(!(error instanceof InputError))console.error('worker failure',error);
      const status=error instanceof InputError?error.status:500;
      return json({error:status===500?'internal server error':error.message},status);
    }
  }
};
