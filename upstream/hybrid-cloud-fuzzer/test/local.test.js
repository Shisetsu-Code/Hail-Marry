import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RateLimiter,safeHttps} from '../local/utils.js';
import {frameSummary,extractFromFrame,adapterHelp} from '../local/extract.js';
import {runImport} from '../local/import-fuzzer.mjs';

const img=Buffer.from([255,216,11,12,13,255,217]);
async function tmp(){return fs.mkdtemp(path.join(os.tmpdir(),'hybrid-fuzzer-test-'));}

test('rate limiter persists across collector sessions, always <=3 game starts per minute',async()=>{
 const dir=await tmp();try{
   let now=1000000000000;const sleep=async ms=>{now+=ms;};
   const p=path.join(dir,'throttle.json');const starts=[];
   for(let i=0;i<2;i++)starts.push(await new RateLimiter(p,{maxPerMinute:3,clock:()=>now,sleep}).reserve());
   for(let i=0;i<3;i++)starts.push(await new RateLimiter(p,{maxPerMinute:3,clock:()=>now,sleep}).reserve());
   for(let i=0;i<starts.length;i++)for(let j=i+3;j<starts.length;j++)assert.ok(starts[j]-starts[i]>=60000);
   for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=20000);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('all explicit HTTPS public provider demos accepted, private hosts and unsafe schemes rejected',()=>{
 assert.equal(safeHttps('https://www.pragmaticplay.fun/en/slots/candy-rush/'),'https://www.pragmaticplay.fun/en/slots/candy-rush/');
 assert.equal(safeHttps('https://cdn.example.com/demo/'),'https://cdn.example.com/demo/');
 for(const bad of ['http://example.org','file:///etc/passwd','https://localhost/path','https://127.0.0.1/game','https://192.168.1.1','https://user:secret@example.org'])assert.throws(()=>safeHttps(bad));
});

test('unknown canvas provider uses visual fallback, known labeled controls use structured or hybrid',()=>{
 assert.equal(frameSummary({state:'BASE',adapter:'generic-dom',opaqueCanvas:true,candidates:[]}).mode,'visual');
 const buy={source:'dom',label:'Buy Bonus',confidence:0.9,rect:{x:0.1,y:0.1,w:0.2,h:0.15}};
 assert.equal(frameSummary({state:'BASE',adapter:'generic-dom',opaqueCanvas:false,candidates:[buy]}).mode,'structured');
 const combined=frameSummary({state:'BASE',adapter:'generic-dom',opaqueCanvas:true,candidates:[buy,{source:'dom',label:'Settings',confidence:.9,rect:{x:.5,y:.2,w:.1,h:.1}}]});
 assert.equal(combined.mode,'hybrid');assert.equal(combined.candidates.length,2);
 assert.equal(frameSummary({state:'INTRO',adapter:'pragmatic-runtime',opaqueCanvas:true,candidates:[buy]}).mode,'visual');
 assert.ok(adapterHelp()['playtech,3oaks,rubyplay,belatra,unknown'].includes('fallback'));
});

test('adapter routing chooses Pragmatic runtime when present and fallback for unrecognized provider',async()=>{
 const fake={evaluate:async fn=>fn.name==='inspectPragmatic'?{supported:true,adapter:'pragmatic-runtime',state:'BASE',opaqueCanvas:true,candidates:[{source:'runtime',label:'Buy Free Spins',confidence:.9,rect:{x:.2,y:.2,w:.15,h:.1}}]}:
   {adapter:'generic-dom',state:'UNKNOWN',opaqueCanvas:true,candidates:[]}};
 const a=await extractFromFrame(fake,{provider:'pragmatic'}),b=await extractFromFrame(fake,{provider:'belatra'});
 assert.equal(a.adapter,'pragmatic-runtime');assert.equal(a.mode,'structured');
 assert.equal(b.adapter,'generic-dom');assert.equal(b.mode,'visual');
});

test('existing Fuzzer-Manual screenshots are converted without reopening games and kept by taskId',async()=>{
 const dir=await tmp();try{
   const old=path.join(dir,'existing'),out=path.join(dir,'out');
   for(const d of ['shots','review','metadata'])await fs.mkdir(path.join(old,d),{recursive:true});
   const controls=[{path:'Game/Main/FeaturePurchase/BuyButton',hit:{x:.1,y:.2,w:.2,h:.3},texts:['BUY FREE SPINS']}];
   const entries={alpha:{slug:'alpha',status:'ready',state:'BASE',taskId:31,image:'shots/alpha.jpg',metadata:'metadata/alpha.json'},
     beta:{slug:'beta',status:'review',state:'INTRO',taskId:32,image:'review/beta.jpg',metadata:'metadata/beta.json'}};
   await fs.writeFile(path.join(old,'manifest.json'),JSON.stringify({runId:'test-run',entries}));
   for(const slug of ['alpha','beta']){
     await fs.writeFile(path.join(old,slug==='alpha'?'shots/alpha.jpg':'review/beta.jpg'),img);
     await fs.writeFile(path.join(old,`metadata/${slug}.json`),JSON.stringify({state:slug==='alpha'?'BASE':'INTRO',controls,viewport:{width:1024,height:576}}));
   }
   assert.deepEqual(await runImport({sourceDir:old,outDir:out,log:()=>{}}),{added:2,skipped:0,missing:0});
   const a=JSON.parse(await fs.readFile(path.join(out,'test-run__pragmatic__alpha__task-31.json')));
   const b=JSON.parse(await fs.readFile(path.join(out,'test-run__pragmatic__beta__task-32.json')));
   assert.equal(a.mode,'structured');assert.equal(a.candidates.length,1);
   assert.equal(b.mode,'visual');assert.equal(b.state,'INTRO');
   assert.deepEqual(await runImport({sourceDir:old,outDir:out,log:()=>{}}),{added:0,skipped:2,missing:0});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('remote synchronization skips previously acknowledged structured items and uses no JPEG',async()=>{
 const dir=await tmp();try{
   process.env.HYBRID_FUZZER_URL='https://example.workers.dev';process.env.HYBRID_INGEST_TOKEN='sync-test';
   const {syncOnce}=await import('../local/sync.mjs?test='+Date.now());
   const item={runId:'r1',provider:'pragmatic',gameId:'a',shotId:'base',state:'BASE',mode:'structured',adapter:'runtime',candidates:[{id:'c0',label:'Buy',source:'runtime',confidence:.9,rect:{x:0,y:0,w:.2,h:.2}}]};
   await fs.writeFile(path.join(dir,'r1__pragmatic__a__base.json'),JSON.stringify(item));let calls=0;
   const fetcher=async (_url,init)=>{calls++;assert.equal(init.headers['Content-Type'],'application/json');return new Response(JSON.stringify({item:{gameId:'a'}}),{status:201,headers:{'Content-Type':'application/json'}});};
   assert.equal((await syncOnce({sourceDir:dir,fetcher,log:()=>{}})).saved,1);
   assert.equal((await syncOnce({sourceDir:dir,fetcher,log:()=>{}})).skipped,1);
   assert.equal(calls,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('runtime controls hidden behind intro are filtered before any candidate-ID decision',()=>{
 const base={adapter:'pragmatic-runtime',state:'INTRO',opaqueCanvas:true,candidates:[
  {source:'runtime',label:'BUY FREE SPINS',path:'Root/Game/FeaturePurchase/Button',rect:{x:.1,y:.1,w:.2,h:.1},confidence:.95},
  {source:'runtime',label:'Play',path:'Root/IntroScreen/Button',rect:{x:.7,y:.4,w:.15,h:.12},confidence:.95}
 ]};
 const intro=frameSummary(base);assert.equal(intro.mode,'visual');assert.equal(intro.candidates.length,1);assert.ok(intro.candidates[0].path.includes('IntroScreen'));
});
