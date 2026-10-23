import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {importGithub} from '../local/import-github.mjs';

const jpeg=new Uint8Array([255,216,1,2,3,255,217]);
const manifest={runId:'pragmatic-20261019',entries:{alpha:{slug:'alpha',taskId:12,status:'ready',image:'shots/alpha.jpg',metadata:'metadata/alpha.json'}}};
const meta={controls:[{path:'Root/FeaturePurchase/BuyButton',hit:{x:.1,y:.2,w:.2,h:.1},texts:['BUY FREE SPINS']}],viewport:{width:1024,height:576},state:'BASE'};
function fakeFetch(url){
 let data;
 if(url.endsWith('/manifest.json'))data=JSON.stringify(manifest);
 else if(url.endsWith('/shots/alpha.jpg'))data=jpeg;
 else if(url.endsWith('/metadata/alpha.json'))data=JSON.stringify(meta);
 else return new Response(null,{status:404});
 return new Response(data,{status:200});
}
test('imports GitHub branch JPEG/metadata directly, never launches a browser and resumes without duplicate work',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hybrid-github-'));
 try{
  const a=await importGithub({outDir:dir,fetcher:fakeFetch,log:()=>{}});
  assert.deepEqual(a,{added:1,skipped:0,missing:0,failed:0});
  const json=JSON.parse(await fs.readFile(path.join(dir,'pragmatic-20261019__pragmatic__alpha__task-12.json')));
  const shot=await fs.readFile(path.join(dir,'pragmatic-20261019__pragmatic__alpha__task-12.jpg'));
  assert.equal(json.mode,'structured');assert.equal(json.provider,'pragmatic');assert.equal(json.candidates.length,1);assert.deepEqual(new Uint8Array(shot),jpeg);
  const b=await importGithub({outDir:dir,fetcher:fakeFetch,log:()=>{}});
  assert.deepEqual(b,{added:0,skipped:1,missing:0,failed:0});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('rejects traversal and mismatched image slugs before any file is downloaded',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hybrid-github-'));
 const broken={runId:'pragmatic-20261019',entries:{bad:{slug:'alpha',taskId:1,status:'ready',image:'shots/../alpha.jpg',metadata:'metadata/alpha.json'}}};
 try{
  let requests=0;
  const fetcher=async url=>{requests++;return new Response(JSON.stringify(broken),{status:200});};
  const out=await importGithub({outDir:dir,fetcher,log:()=>{}});
  assert.equal(out.failed,1);assert.equal(requests,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
