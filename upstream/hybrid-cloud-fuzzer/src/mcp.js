// Stateless MCP over HTTP. No custom app/plugin installation needed for HTTP-capable clients.
import {InputError,claim,save,release,rawItem,publicItem,stats,auditClassifications} from './core.js';
import {listValidations,validationPreview} from './capture-validation.js';
import {listCaptureReviews,reviewRow,reviewPublic,instructCapture} from './capture-review.js';
const text=v=>({type:'text',text:JSON.stringify(v)});
const str={type:'string'};
const schema=(props,required=[])=>({type:'object',properties:props,required,additionalProperties:false});
const mark=schema({x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1},kind:{enum:['buy','navigate','pick','other']},label:str},['x','y','kind','label']);
const choice=schema({candidateId:str,kind:{enum:['buy','navigate','pick','other']}},['candidateId','kind']);
const saveFields={id:str,leaseId:str,revision:{type:'integer'},sourceSha256:str,status:{enum:['classified','needs_review']},reviewer:str,selections:{type:'array',items:choice,maxItems:40},marks:{type:'array',items:mark,maxItems:40}};
const saveRequired=['id','leaseId','revision','sourceSha256','status','reviewer'];
export const definitions=[
  {name:'capture_reviews',description:'List screenshots awaiting GPT quality review in the SAME batch, outside the valid classification queue. Paginate with nextAfterId.',inputSchema:schema({runId:str,afterId:str,limit:{type:'integer',minimum:1,maximum:50}},['runId'])},
  {name:'capture_review_image',description:'Inspect latest screenshot and its exact revision/session/hash before deciding wait, click or approve.',inputSchema:schema({id:str},['id'])},
  {name:'capture_review_action',description:'ASYNCHRONOUS: GPT may reply after all runners stop. Persist next quality action for the next manual execution in the same batch: wait then recapture, click normalized coordinates then recapture, or approve as valid. Cleanup only; never spin/buy/bet. initialWaitMs sets future launch delay for this game only. Approval immediately promotes the stored JPEG into the valid queue; it does not classify gameplay controls.',inputSchema:schema({id:str,sessionId:str,revision:{type:'integer',minimum:1},imageSha256:str,action:{enum:['wait','click','approve']},x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1},waitMs:{type:'integer',minimum:0,maximum:120000},initialWaitMs:{type:'integer',minimum:1000,maximum:120000},reason:str,reviewer:str},['id','sessionId','revision','imageSha256','action','reason','reviewer'])},
  {name:'next_item',description:'Claim next screenshot or structured control block. When mode is visual/hybrid returns JPEG too. Review immediately.',inputSchema:schema({runId:str,provider:str,leaseSeconds:{type:'integer',minimum:30,maximum:900}})},
  {name:'save_classification',description:'Save selected candidate IDs or normalized visual marks in one call. Do NOT execute any clicks here.',inputSchema:schema(saveFields,saveRequired)},
  {name:'save_and_next',description:'Save all decisions atomically and immediately claim the next item in the same MCP call; returns JPEG only for visual/hybrid modes.',inputSchema:schema({...saveFields,runId:str,provider:str,leaseSeconds:{type:'integer',minimum:30,maximum:900}},saveRequired)},
  {name:'get_item',description:'Reload an actively leased task. Use includeImage=true to load a backup JPEG for an otherwise structured task.',inputSchema:schema({id:str,leaseId:str,includeImage:{type:'boolean'}},['id','leaseId'])},
  {name:'release_item',description:'Return leased item to the pending queue.',inputSchema:schema({id:str,leaseId:str,revision:{type:'integer'}},['id','leaseId','revision'])},
  {name:'queue_stats',description:'Fast count of pending/leased/classified/needs_review.',inputSchema:schema({runId:str,provider:str})},
  {name:'audit_capture_validations',description:'READ-ONLY: list capture readiness checks, including rejected screenshots outside the classification queue.',inputSchema:schema({runId:str,cursor:str,limit:{type:'integer',minimum:1,maximum:50}},['runId'])},
  {name:'capture_validation_preview',description:'READ-ONLY: view annotated current image and same-game reference comparison for a validation report.',inputSchema:schema({id:str},['id'])},
  {name:'audit_classifications',description:'READ-ONLY: list past classifications with original candidate paths, coordinates and decisions. Paginate with nextAfterId. Does not claim tasks or change D1.',inputSchema:schema({runId:str,provider:str,status:{enum:['classified','needs_review']},afterId:str,limit:{type:'integer',minimum:1,maximum:50},includeCandidates:{type:'boolean'}})},
  {name:'audit_item',description:'READ-ONLY: inspect one previously classified item, optionally loading its R2 JPEG for visual verification. No lease needed.',inputSchema:schema({id:str,includeImage:{type:'boolean'}},['id'])}
];
export function compact(item){
  if(!item)return item;
  const {metadata,candidates,...other}=item;
  const minimalMetadata={};
  for(const key of ['url','frameUrl','opaqueCanvas','frameAligned','source'])if(metadata?.[key]!=null)minimalMetadata[key]=metadata[key];
  if(metadata?.captureValidation){const v=metadata.captureValidation;minimalMetadata.captureValidation={status:v.status,reasons:v.reasons,reportId:v.reportId,validatorVersion:v.validatorVersion,referenceId:v.referenceId,anchors:v.anchors};}
  if(metadata?.networkDiagnostics?.summary){
    minimalMetadata.networkDiagnostics={format:'sanitized-har-1.2',summary:metadata.networkDiagnostics.summary};
  }
  return {...other,candidates:(candidates||[]).map(({id,label,role,rect,confidence})=>({id,label,role,rect,confidence})),metadata:minimalMetadata};
}
function toBase64(bytes){const b=new Uint8Array(bytes);let s='';for(let i=0;i<b.length;i+=12288)s+=btoa(String.fromCharCode(...b.subarray(i,i+12288)));return s;}
async function loadImage(env,row){
  if(!row.image_key)return null;
  const obj=await env.IMAGES.get(row.image_key);if(!obj)throw new InputError('JPEG missing in R2',404);
  return {type:'image',mimeType:'image/jpeg',data:toBase64(await obj.arrayBuffer())};
}
async function claimed(env,item){
  if(!item)return {content:[text({empty:true})]};
  const raw=await rawItem(env,item.id);
  const image=item.mode==='structured'?null:await loadImage(env,raw);
  return {content:[text({item:compact(item),classificationHint:'Select all relevant candidate IDs. Use image marks only when needed.'}),...(image?[image]:[])]};
}
async function tool(env,name,arg){
  switch(name){
    case 'capture_reviews':return {content:[text(await listCaptureReviews(env,arg))]};
    case 'capture_review_image':{
      const row=await reviewRow(env,arg.id);return {content:[text({review:reviewPublic(row),hint:'Review loading/entry/cookie overlays. Only approve a clean usable image; otherwise instruct wait or a cleanup click. No gameplay actions.'}),await loadImage(env,row)]};
    }
    case 'capture_review_action':return {content:[text({review:await instructCapture(env,arg)})]};
    case 'audit_capture_validations':return {content:[text(await listValidations(env,arg))]};
    case 'capture_validation_preview':{
      const obj=await validationPreview(env,arg.id);return {content:[{type:'image',mimeType:'image/jpeg',data:toBase64(await obj.arrayBuffer())}]};
    }
    case 'next_item':return claimed(env,await claim(env,arg));
    case 'save_and_next':{
      const saved=await save(env,arg);
      let next=null;
      try{next=await claim(env,{runId:arg.runId??saved.runId,provider:arg.provider??null,leaseSeconds:arg.leaseSeconds??180});}
      catch(error){return {content:[text({saved:true,savedItem:compact(saved),nextError:error instanceof InputError?error.message:'queue temporarily unavailable'})]};}
      if(!next)return {content:[text({saved:true,savedItem:compact(saved),next:{empty:true}})]};
      const raw=await rawItem(env,next.id),image=next.mode==='structured'?null:await loadImage(env,raw);
      return {content:[text({saved:true,savedItem:compact(saved),next:{item:compact(next)}}),...(image?[image]:[])]};
    }
    case 'save_classification':return {content:[text({saved:true,item:compact(await save(env,arg))})]};
    case 'release_item':return {content:[text({released:true,item:await release(env,arg)})]};
    case 'queue_stats':return {content:[text(await stats(env,arg))]};
    case 'audit_classifications':return {content:[text(await auditClassifications(env,arg))]};
    case 'audit_item':{
      const row=await rawItem(env,arg.id);
      if(!['classified','needs_review'].includes(row.status))throw new InputError('item has not been classified',409);
      const picture=arg.includeImage===true?await loadImage(env,row):null;
      return {content:[text({item:publicItem(row)}),...(picture?[picture]:[])]};
    }
    case 'get_item':{
      const row=await rawItem(env,arg.id),now=Math.floor(Date.now()/1000);
      if(row.status!=='leased'||row.lease_id!==arg.leaseId||row.lease_until<=now)throw new InputError('lease not active',409);
      const image=(row.mode!=='structured'||arg.includeImage===true)?await loadImage(env,row):null;
      return {content:[text({item:compact(publicItem(row))}),...(image?[image]:[])]};
    }
    default:throw new InputError('unknown tool',404);
  }
}
const result=(id,data)=>({jsonrpc:'2.0',id,result:data});
const rpcError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
function respond(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
export async function handleMcp(request,env){
  if(request.method==='DELETE')return new Response(null,{status:204});
  if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST, DELETE'}});
  let m;try{m=await request.json();}catch{return respond(rpcError(null,-32700,'invalid JSON'),400);}
  if(!m||m.jsonrpc!=='2.0'||typeof m.method!=='string')return respond(rpcError(m?.id??null,-32600,'invalid request'),400);
  if(!Object.hasOwn(m,'id'))return new Response(null,{status:202});
  try{
    switch(m.method){
      case 'initialize':return respond(result(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'hybrid-cloud-fuzzer',version:'0.1.0'}}));
      case 'ping':return respond(result(m.id,{}));
      case 'tools/list':return respond(result(m.id,{tools:definitions}));
      case 'tools/call':{
        const args=m.params?.arguments||{};
        if(typeof m.params?.name!=='string'||typeof args!=='object'||args===null||Array.isArray(args))return respond(rpcError(m.id,-32602,'invalid arguments'));
        try{return respond(result(m.id,await tool(env,m.params.name,args)));}
        catch(e){return respond(result(m.id,{content:[text({error:e instanceof InputError?e.message:'internal server error'})],isError:true}));}
      }
      default:return respond(rpcError(m.id,-32601,'method not found'));
    }
  }catch(e){console.error('mcp error',e);return respond(rpcError(m.id,-32603,'internal server error'));}
}
