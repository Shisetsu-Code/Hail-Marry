import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Only the external HTTP boundary is faked: trees, blobs and commits persist
// across publisher instances and requests enforce Git's ancestry contract.
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
class GitHub {
  constructor() { this.blobs=new Map(); this.trees=new Map(); this.commits=new Map(); this.refs=new Map(); this.requests=[]; this.serial=0; this.conflicts=0; }
  id() { return (++this.serial).toString(16).padStart(40,'0'); }
  putBlob(bytes) { const sha=blobSha(bytes); this.blobs.set(sha,Buffer.from(bytes)); return sha; }
  putTree(entries=[]) { const sha=this.id(); this.trees.set(sha,structuredClone(entries)); return sha; }
  commit(tree,parents=[]) { const sha=this.id(); this.commits.set(sha,{sha,tree:{sha:tree},parents:parents.map(sha=>({sha}))}); return sha; }
  seed(files,branch='classifier-data') {
    const tree=this.buildTree(new Map(Object.entries(files).map(([name,bytes])=>[name,{mode:'100644',type:'blob',sha:this.putBlob(Buffer.from(bytes))}])));
    const sha=this.commit(tree); this.refs.set(`heads/${branch}`,sha); return sha;
  }
  flatten(tree,prefix='',files=new Map()) {
    for(const entry of this.trees.get(tree)||[]) {
      const name=prefix+entry.path;
      if(entry.type==='tree') this.flatten(entry.sha,name+'/',files); else files.set(name,{...entry,path:undefined});
    }
    return files;
  }
  buildTree(files) {
    const root=new Map();
    for(const [name,entry] of files) {
      const parts=name.split('/'); let dir=root;
      for(const part of parts.slice(0,-1)) { if(!dir.has(part)) dir.set(part,new Map()); dir=dir.get(part); }
      dir.set(parts.at(-1),entry);
    }
    const build=dir=>this.putTree([...dir].map(([name,value])=>value instanceof Map
      ? {path:name,mode:'040000',type:'tree',sha:build(value)} : {...value,path:name}));
    return build(root);
  }
  files(branch='classifier-data') {
    const head=this.refs.get(`heads/${branch}`); return head ? this.flatten(this.commits.get(head).tree.sha) : new Map();
  }
  bytes(name,branch) { return this.blobs.get(this.files(branch).get(name)?.sha); }
  fetch=async (url,options={}) => {
    const method=options.method||'GET', pathname=new URL(url).pathname, route=pathname.replace('/repos/owner/repo','');
    const body=options.body?JSON.parse(options.body):undefined;
    this.requests.push({method,route,body});
    if(this.respond) { const result=await this.respond({method,route,body}); if(result) return result; }
    const ok=(data,status=200)=>new Response(JSON.stringify(data),{status});
    if(route===''&&method==='GET') return ok({full_name:'owner/repo'});
    if(route.startsWith('/git/matching-refs/')&&method==='GET') {
      const prefix=decodeURIComponent(route.slice('/git/matching-refs/'.length));
      return ok([...this.refs].filter(([ref])=>ref.startsWith(prefix)).map(([ref,sha])=>({ref:'refs/'+ref,object:{type:'commit',sha}})));
    }
    if(route.startsWith('/git/ref/')&&method==='GET') {
      const ref=decodeURIComponent(route.slice('/git/ref/'.length)), sha=this.refs.get(ref);
      return sha?ok({ref:'refs/'+ref,object:{type:'commit',sha}}):ok({message:'Not Found'},404);
    }
    if(route==='/git/refs'&&method==='POST') {
      const ref=body.ref.replace(/^refs\//,'');
      if(this.refs.has(ref)) return ok({message:'Reference already exists'},422);
      assert.ok(this.commits.has(body.sha)); this.refs.set(ref,body.sha); return ok({ref:body.ref,object:{sha:body.sha}},201);
    }
    if(route.startsWith('/git/refs/')&&method==='PATCH') {
      assert.equal(body.force,false,'must never force an update');
      const ref=decodeURIComponent(route.slice('/git/refs/'.length));
      if(this.conflicts>0) {
        this.conflicts--; const current=this.refs.get(ref), files=this.flatten(this.commits.get(current).tree.sha);
        files.set('parallel-run/state.json',{mode:'100644',type:'blob',sha:this.putBlob(Buffer.from('{"parallel":true}'))});
        this.refs.set(ref,this.commit(this.buildTree(files),[current]));
      }
      const previous=this.refs.get(ref), commit=this.commits.get(body.sha);
      if(!commit.parents.some(parent=>parent.sha===previous)) return ok({message:'Update is not a fast forward'},422);
      this.refs.set(ref,body.sha); return ok({ref:'refs/'+ref,object:{sha:body.sha}});
    }
    if(route==='/git/blobs'&&method==='POST') {
      assert.equal(body.encoding,'base64'); const bytes=Buffer.from(body.content,'base64'); return ok({sha:this.putBlob(bytes)},201);
    }
    if(route.startsWith('/git/blobs/')&&method==='GET') {
      const sha=route.split('/').at(-1), bytes=this.blobs.get(sha);
      return bytes?ok({sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')}):ok({},404);
    }
    if(route==='/git/trees'&&method==='POST') {
      // GitHub rejects POST /git/trees {tree:[]} even in a nonempty repository.
      if(!body.tree?.length) return ok({message:'Invalid tree info'},422);
      const files=body.base_tree?this.flatten(body.base_tree):new Map();
      for(const entry of body.tree) { if(entry.sha===null) files.delete(entry.path); else files.set(entry.path,{...entry,path:undefined}); }
      const sha=this.buildTree(files); return ok({sha,tree:this.trees.get(sha),truncated:false},201);
    }
    if(route.startsWith('/git/trees/')&&method==='GET') {
      const sha=route.split('/').at(-1); return this.trees.has(sha)?ok({sha,tree:this.trees.get(sha),truncated:false}):ok({},404);
    }
    if(route==='/git/commits'&&method==='POST') { const sha=this.commit(body.tree,body.parents); return ok(this.commits.get(sha),201); }
    if(route.startsWith('/git/commits/')&&method==='GET') return ok(this.commits.get(route.split('/').at(-1)));
    throw new Error(`Unexpected fake request: ${method} ${route}`);
  };
}
async function fixture(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'classifier-publisher-'));
  t.after(()=>rm(directory,{recursive:true,force:true})); await mkdir(path.join(directory,'images'));
  await writeFile(path.join(directory,'state.json'),'{"schemaVersion":1,"runId":"run-one","games":[]}\n');
  const image=Buffer.from([0xff,0xd8,0,10,13,255,254,0xff,0xd9]);
  await writeFile(path.join(directory,'images','game-1.jpg'),image);
  const github=new GitHub();
  // Dynamic import lets the first RED name the missing implementation explicitly.
  const {RepositoryPublisher}=await import('../publisher.mjs');
  const publisher=new RepositoryPublisher({directory,repository:'owner/repo',runId:'run-one',token:'secret-test-token',fetchImpl:github.fetch});
  return {directory,image,github,publisher,RepositoryPublisher};
}

test('initializes an independent README root despite GitHub rejecting empty trees, then publishes exact run evidence',async t=>{
  const {directory,image,github,publisher}=await fixture(t);
  const main=github.seed({'application.txt':'main source'},'main');
  const result=await publisher.publish();
  assert.equal(result.branch,'classifier-data'); assert.equal(result.commit,github.refs.get('heads/classifier-data'));
  assert.equal(result.url,`https://github.com/owner/repo/tree/classifier-data/run-one`);
  assert.deepEqual(github.bytes('run-one/state.json'),await readFile(path.join(directory,'state.json')));
  assert.deepEqual(github.bytes('run-one/images/game-1.jpg'),image);
  assert.equal(github.refs.get('heads/main'),main);
  const root=[...github.commits.values()].find(commit=>commit.parents.length===0&&commit.sha!==main);
  const entries=github.trees.get(root.tree.sha);
  assert.deepEqual(entries.map(entry=>entry.path),['README.md'],'orphan root contains only data-branch documentation');
  assert.equal(entries[0].mode,'100644');
  const readme=github.blobs.get(entries[0].sha).toString('utf8');
  assert.match(readme,/classifier.*evidence/i);
  assert.match(readme,/state\.json/); assert.match(readme,/images/);
  assert.ok(!readme.includes('secret-test-token'),'root documentation never contains the repository token');
  assert.deepEqual(github.bytes('README.md'),Buffer.from(readme),'publishing a run preserves branch documentation');
  assert.equal(github.bytes('application.txt'),undefined,'the orphan data branch never inherits main source');
});

test('preserves other runs and skips blob, tree and commit creation for unchanged data',async t=>{
  const {github,publisher}=await fixture(t);
  github.seed({'other-run/state.json':'other bytes','other-run/images/a.jpg':'other image'});
  const first=await publisher.publish(), counts=github.requests.length;
  const second=await publisher.publish();
  assert.equal(second.commit,first.commit);
  assert.deepEqual(github.bytes('other-run/state.json'),Buffer.from('other bytes'));
  assert.deepEqual(github.bytes('other-run/images/a.jpg'),Buffer.from('other image'));
  assert.equal(github.requests.slice(counts).filter(r=>r.method!=='GET').length,0);
  assert.ok(github.requests.length-counts<=2,'unchanged head needs no per-file API calls');
});

test('restores bytes on restart using only this run’s whitelisted regular files',async t=>{
  const {directory,image,github,publisher,RepositoryPublisher}=await fixture(t); await publisher.publish();
  const restored=path.join(directory,'restart');
  const next=new RepositoryPublisher({directory:restored,repository:'owner/repo',runId:'run-one',token:'secret-test-token',fetchImpl:github.fetch});
  const result=await next.restore();
  assert.equal(result.restored,true); assert.deepEqual(await readFile(path.join(restored,'images','game-1.jpg')),image);
  assert.deepEqual(await readFile(path.join(restored,'state.json')),await readFile(path.join(directory,'state.json')));
  const before=github.requests.length; await next.publish();
  assert.equal(github.requests.slice(before).filter(r=>r.method!=='GET').length,0,'restart can reuse persisted blob identities');
});

test('retries non-fast-forward commits against the new tree without losing parallel run writes',async t=>{
  const {github,publisher}=await fixture(t); github.seed({'other-run/state.json':'original'}); github.conflicts=1;
  await publisher.publish();
  assert.deepEqual(github.bytes('other-run/state.json'),Buffer.from('original'));
  assert.deepEqual(github.bytes('parallel-run/state.json'),Buffer.from('{"parallel":true}'));
  assert.ok(github.bytes('run-one/state.json'));
  assert.equal(github.requests.filter(r=>r.method==='POST'&&r.route==='/git/blobs').length,2,'conflict does not upload identical blobs twice');
});

test('rejects empty evidence and state belonging to a different run before publishing',async t=>{
  const {directory,github,publisher}=await fixture(t);
  await writeFile(path.join(directory,'images','game-1.jpg'),Buffer.alloc(0));
  await assert.rejects(publisher.publish(),/evidence/i);
  assert.equal(github.refs.size,0);
  await writeFile(path.join(directory,'images','game-1.jpg'),'valid image');
  await writeFile(path.join(directory,'state.json'),'{"schemaVersion":1,"runId":"different","games":[]}');
  await assert.rejects(publisher.publish(),/state|run/i);
  assert.equal(github.refs.size,0);
});

test('rejects a remote state from another run before writing any files',async t=>{
  const {directory,github,publisher}=await fixture(t);
  github.seed({'run-one/state.json':'{"schemaVersion":1,"runId":"different","games":[]}', 'run-one/images/game-1.jpg':'remote image'});
  const before=await readFile(path.join(directory,'state.json'));
  await assert.rejects(publisher.restore(),/state|run/i);
  assert.deepEqual(await readFile(path.join(directory,'state.json')),before);
});

test('uses bounded conflict retries and surfaces failure rather than reporting durable success',async t=>{
  const {github,publisher}=await fixture(t); github.seed({'other-run/state.json':'keep'}); github.conflicts=100;
  await assert.rejects(publisher.publish(),/changed repeatedly/);
  assert.equal(github.bytes('run-one/state.json'),undefined);
  assert.ok(github.requests.filter(r=>r.method==='PATCH').length<=5,'retry bound prevents runaway commits');
});

test('serializes publication snapshots and continues after a failed publication',async t=>{
  const {directory,github,publisher}=await fixture(t);
  github.seed({'other-run/state.json':'keep'});
  let reached,release;
  const ready=new Promise(resolve=>{reached=resolve;}); const gate=new Promise(resolve=>{release=resolve;});
  let blocked=false;
  github.respond=async ({method,route})=>{
    if(method==='POST'&&route==='/git/blobs'&&!blocked) { blocked=true; reached(); await gate; }
  };
  const first=publisher.publish(); await ready;
  const updated='{"schemaVersion":1,"runId":"run-one","games":[],"revision":2}\n';
  await writeFile(path.join(directory,'state.json'),updated);
  const second=publisher.publish(); release(); const [a,b]=await Promise.all([first,second]);
  assert.notEqual(a.commit,b.commit); assert.deepEqual(github.bytes('run-one/state.json'),Buffer.from(updated));
  github.respond=({method})=>method==='GET'?new Response('{}',{status:503}):undefined;
  await assert.rejects(publisher.publish(),/HTTP 503/);
  github.respond=null; assert.equal((await publisher.publish()).commit,b.commit);
});

test('does not overwrite immutable remote image filenames with changed local bytes',async t=>{
  const {directory,github,publisher}=await fixture(t); const original=await publisher.publish();
  await writeFile(path.join(directory,'images','game-1.jpg'),'replacement');
  await assert.rejects(publisher.publish(),/immutable/);
  assert.equal(github.refs.get('heads/classifier-data'),original.commit);
});

test('distinguishes a missing branch from inaccessible repositories and sanitizes transport/API errors',async t=>{
  const {github,publisher,RepositoryPublisher,directory}=await fixture(t);
  assert.equal((await publisher.restore()).restored,false); assert.equal(github.refs.size,0);
  const secret='a-very-secret-GITHUB_TOKEN';
  const denied=new RepositoryPublisher({directory,repository:'owner/repo',runId:'run-one',token:secret,fetchImpl:async()=>new Response(JSON.stringify({message:`Authorization: Bearer ${secret}`}),{status:404})});
  await assert.rejects(denied.restore(),error=>/HTTP 404/.test(error.message)&&!String(error.stack).includes(secret)&&!String(error.stack).includes('Bearer'));
  const network=new RepositoryPublisher({directory,repository:'owner/repo',runId:'run-one',token:secret,fetchImpl:async()=>{throw new Error(`Authorization: Bearer ${secret}`);}});
  await assert.rejects(network.publish(),error=>/transport failed/.test(error.message)&&!String(error.stack).includes(secret));
  const unauthorized=new RepositoryPublisher({directory,repository:'owner/repo',runId:'run-one',token:secret,fetchImpl:async()=>new Response(JSON.stringify({message:secret}),{status:401})});
  await assert.rejects(unauthorized.publish(),error=>/HTTP 401/.test(error.message)&&!String(error.stack).includes(secret));
});

test('never restores symlink blobs, unsafe paths or unverified bytes',async t=>{
  const {directory,github,publisher}=await fixture(t);
  github.seed({'run-one/state.json':'{"schemaVersion":1,"runId":"run-one","games":[]}', 'run-one/images/game-1.jpg':'remote image', 'different-run/state.json':'ignored'});
  const before=await readFile(path.join(directory,'state.json'));
  const files=github.files(); files.set('run-one/images/game-1.jpg',{mode:'120000',type:'blob',sha:github.putBlob(Buffer.from('/etc/passwd'))});
  github.refs.set('heads/classifier-data',github.commit(github.buildTree(files)));
  await assert.rejects(publisher.restore(),/regular files/);
  assert.deepEqual(await readFile(path.join(directory,'state.json')),before);
  files.set('run-one/images/game-1.jpg',{mode:'100644',type:'blob',sha:github.putBlob(Buffer.from('remote image'))});
  files.set('run-one/images/../escape.jpg',{mode:'100644',type:'blob',sha:github.putBlob(Buffer.from('escape'))});
  github.refs.set('heads/classifier-data',github.commit(github.buildTree(files)));
  await assert.rejects(publisher.restore(),/unsafe data tree/);
  files.delete('run-one/images/../escape.jpg'); github.refs.set('heads/classifier-data',github.commit(github.buildTree(files)));
  github.respond=({method,route})=>method==='GET'&&route.startsWith('/git/blobs/')?new Response(JSON.stringify({sha:route.split('/').at(-1),size:4,encoding:'base64',content:Buffer.from('fake').toString('base64')})):undefined;
  await assert.rejects(publisher.restore(),/checksum/);
  assert.deepEqual(await readFile(path.join(directory,'state.json')),before);
});

test('rejects symlinked local evidence and symlinked restore destinations',async t=>{
  const {directory,github,publisher,RepositoryPublisher}=await fixture(t); await publisher.publish();
  const outside=path.join(directory,'outside'); await writeFile(outside,'unchanged');
  await rm(path.join(directory,'images','game-1.jpg')); await symlink(outside,path.join(directory,'images','game-1.jpg'));
  await assert.rejects(publisher.publish(),/unsafe/); await assert.rejects(publisher.restore(),/unsafe/);
  assert.equal(await readFile(outside,'utf8'),'unchanged');
  const redirected=path.join(directory,'redirected'); await symlink(path.join(directory,'images'),redirected);
  const other=new RepositoryPublisher({directory:redirected,repository:'owner/repo',runId:'run-one',token:'secret',fetchImpl:github.fetch});
  await assert.rejects(other.restore(),/unsafe/);
});

test('rejects truncated trees and oversized remote blobs without downloading them',async t=>{
  const {github,publisher}=await fixture(t); await publisher.publish();
  let blobs=0;
  github.respond=({method,route})=>{
    if(method==='GET'&&route.startsWith('/git/blobs/')) { blobs++; return new Response(JSON.stringify({sha:route.split('/').at(-1),size:1024*1024*1024,encoding:'base64',content:''})); }
  };
  await assert.rejects(publisher.restore(),/oversized/); assert.equal(blobs,1);
  const head=github.refs.get('heads/classifier-data'), commit=github.commits.get(head);
  github.refs.set('heads/classifier-data',github.commit(commit.tree.sha,[head]));
  github.respond=({method,route})=>method==='GET'&&route.startsWith('/git/trees/')?new Response(JSON.stringify({sha:route.split('/').at(-1),tree:[],truncated:true})):undefined;
  await assert.rejects(publisher.restore(),/incomplete/);
});

test('creates only a changed state blob while retaining this run’s previous images',async t=>{
  const {directory,github,publisher}=await fixture(t); await publisher.publish();
  await rm(path.join(directory,'images','game-1.jpg'));
  await writeFile(path.join(directory,'state.json'),'{"schemaVersion":1,"runId":"run-one","games":[],"revision":10}');
  const before=github.requests.length; await publisher.publish();
  assert.equal(github.requests.slice(before).filter(r=>r.method==='POST'&&r.route==='/git/blobs').length,1);
  assert.ok(github.bytes('run-one/images/game-1.jpg'),'durable screenshots remain append-only when absent locally');
});

test('recovers from a concurrent first creator of the data branch',async t=>{
  const {github,publisher}=await fixture(t); let raced=false;
  github.respond=({method,route})=>{
    if(!raced&&method==='POST'&&route==='/git/refs') { raced=true; github.seed({'first-run/state.json':'first creator'}); return new Response('{}',{status:422}); }
  };
  await publisher.publish();
  assert.deepEqual(github.bytes('first-run/state.json'),Buffer.from('first creator')); assert.ok(github.bytes('run-one/state.json'));
});

test('validates the dedicated branch and run prefix before any HTTP call',async t=>{
  const {RepositoryPublisher,directory,github}=await fixture(t);
  const options={directory,repository:'owner/repo',runId:'run-one',token:'secret',fetchImpl:github.fetch};
  for(const branch of ['main','master','../main','refs/../main','a.lock','with space','a//b']) assert.throws(()=>new RepositoryPublisher({...options,branch}),/dedicated data branch/);
  for(const runId of ['../other','other/run','..','/absolute']) assert.throws(()=>new RepositoryPublisher({...options,runId}),/safe runId/);
  assert.equal(github.requests.length,0);
});
