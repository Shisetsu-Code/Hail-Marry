import test from 'node:test';import assert from 'node:assert/strict';
import {storeValidation,listValidations,validationPreview,validationReference} from '../src/capture-validation.js';
import {compact} from '../src/mcp.js';
test('GPT receives readiness evidence without private comparison image bytes',()=>{
 const item=compact({id:'one',candidates:[],metadata:{captureValidation:{status:'ready',reasons:['same-game-instruments-match'],reportId:'report',preview:'do-not-send-image-bytes'}}});
 assert.equal(item.metadata.captureValidation.status,'ready');assert.equal(item.metadata.captureValidation.preview,undefined);
});
test('an invalidated reference can be replaced only by an approved image of the same game',async()=>{
 const objects=new Map([['validation/profiles/p/g.json',JSON.stringify({id:'old',provider:'p',gameId:'g',imageSha256:'b'.repeat(64)})]]);
 const row={id:'new',provider:'p',game_id:'g',image_sha256:'a'.repeat(64),status:'classified'};
 const env={IMAGES:{get:async key=>objects.has(key)?{text:async()=>objects.get(key)}:null,put:async(k,v)=>objects.set(k,v)},DB:{prepare(sql){return {bind(...args){return {first:async()=>args[0]==='new'?row:null,all:async()=>({results:[]})};}};}}};
 await storeValidation(env,{runId:'r',provider:'p',gameId:'g',validatorVersion:'1',status:'ready',reasons:['same-game-instruments-match'],referenceId:'new',referenceSha256:'a'.repeat(64),sourceImageSha256:'a'.repeat(64),anchors:[{role:'balance',rect:[.1,.8,.1,.1]},{role:'bet',rect:[.3,.8,.1,.1]}]},new Uint8Array([255,216,255,217]));
 assert.equal((await validationReference(env,{provider:'p',gameId:'g'})).reference.id,'new');
});
test('approved intro controls provide a game-specific visual reference without copying other games',async()=>{
 const row={id:'r:p:g:base',provider:'p',game_id:'g',image_sha256:'a'.repeat(64),revision:2,metadata_json:'{}',decisions_json:JSON.stringify({allMarks:[{kind:'navigate',label:'START',x:.5,y:.8}]})};
 const env={IMAGES:{get:async()=>null},DB:{prepare:()=>({bind:(provider,game)=>({all:async()=>({results:provider==='p'&&game==='g'?[row]:[]})})})}};
 const {reference}=await validationReference(env,{provider:'p',gameId:'g'});assert.equal(reference.stage,'intro');assert.equal(reference.anchors[0].role,'start');
 assert.equal((await validationReference(env,{provider:'p',gameId:'another'})).reference,null);
 row.decisions_json=JSON.stringify({allMarks:[{kind:'navigate',label:'Start spin',x:.5,y:.8}]});assert.equal((await validationReference(env,{provider:'p',gameId:'g'})).reference,null);
});
test('rejected captures remain private R2 diagnostics and never enter classification D1',async()=>{
 const objects=new Map();let writes=0;
 const env={DB:{prepare(){writes++;throw Error('diagnostics must not write D1');}},IMAGES:{
  put:async(k,v)=>objects.set(k,v),get:async k=>objects.has(k)?{text:async()=>objects.get(k),body:objects.get(k)}:null,
  list:async({prefix})=>({objects:[...objects.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false})}};
 const report=await storeValidation(env,{runId:'run-a',provider:'3oaks',gameId:'one',status:'loading',reasons:['loading-screen'],validatorVersion:'1'},new Uint8Array([255,216,0,255,217]));
 assert.match(report.id,/^[a-f0-9]{64}$/);assert.equal(writes,0);
 assert.equal((await listValidations(env,{runId:'run-a'})).items[0].status,'loading');
 assert.equal((await listValidations(env,{runId:'run-b'})).items.length,0);
 assert.ok(await validationPreview(env,report.id));
 await assert.rejects(storeValidation(env,{...report,runId:'../outside'},new Uint8Array([255,216,255,217])));
 await assert.rejects(validationPreview(env,'../private'));
});
