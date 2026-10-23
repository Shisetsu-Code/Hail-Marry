import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CloudClient} from '../local/cloud-client.js';
const image=Buffer.from([255,216,3,4,255,217]);
const reference={itemId:'r:bgaming:a:base',revision:2,sourceSha256:'a'.repeat(64),imageSha256:createHash('sha256').update(image).digest('hex')};
const item={id:reference.itemId,status:'classified',...reference};
function client(overrides={},bytes=image){
 const seen=[];
 return {seen,cloud:new CloudClient({endpoint:'https://example.com',reviewToken:'review-fixture',ingestToken:'ingest-fixture',fetcher:async(url,options)=>{
  seen.push(url);assert.equal(options.headers.Authorization,'Bearer review-fixture');
  return url.endsWith('/image')?new Response(bytes):Response.json({item:{...item,...overrides}});
 }})};
}
test('visual replay downloads only a still-classified exact revision with matching image hash',async()=>{
 const {cloud,seen}=client();assert.deepEqual(await cloud.reviewedImage(reference),image);assert.equal(seen.length,2);
});
test('changed classification and corrupted images cannot authorize a visual click',async()=>{
 const changed=client({revision:3});await assert.rejects(()=>changed.cloud.reviewedImage(reference),/classification changed/);assert.equal(changed.seen.length,1);
 const corrupted=client({},Buffer.from('different'));await assert.rejects(()=>corrupted.cloud.reviewedImage(reference),/hash mismatch/);
});
