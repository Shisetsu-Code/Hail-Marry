import { lstat, mkdir, readdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const STATE_LIMIT=32*1024*1024, IMAGE_LIMIT=12*1024*1024, TOTAL_LIMIT=512*1024*1024;
const MAX_FILES=25000, MAX_ATTEMPTS=4;
const imageName=name=>typeof name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.jpg$/.test(name)&&!name.includes('..');
const gitSha=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha=value=>{ if(typeof value!=='string'||!/^[a-f0-9]{40}$/.test(value)) throw new Error('GitHub returned an invalid object identity'); return value; };
const segment=value=>encodeURIComponent(value);

class GitHubError extends Error {
  constructor(status) { super(`GitHub persistence request failed (HTTP ${status})`); this.status=status; }
}

/** Append-only screenshot evidence and the latest state, isolated to one data-branch prefix. */
export class RepositoryPublisher {
  constructor({directory,repository,branch='classifier-data',runId,token=process.env.GITHUB_TOKEN,fetchImpl=fetch}={}) {
    if(typeof repository!=='string'||!repository.split('/').every(part=>/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part))||repository.split('/').length!==2)
      throw new Error('A valid owner/repository is required');
    if(typeof branch!=='string'||!branch||['main','master','HEAD'].includes(branch)||branch.startsWith('-')||branch.startsWith('/')||branch.endsWith('/')||branch.endsWith('.')||/[\x00-\x20\x7f~^:?*\[\\]/.test(branch)||branch.includes('..')||branch.includes('@{')||branch.includes('//')||branch.split('/').some(part=>part.startsWith('.')||part.endsWith('.lock')))
      throw new Error('A dedicated data branch is required');
    if(typeof runId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(runId)) throw new Error('A safe runId is required');
    if(typeof directory!=='string'||!directory) throw new Error('A local data directory is required');
    if(typeof fetchImpl!=='function') throw new Error('An HTTP transport is required');
    this.directory=path.resolve(directory); this.repository=repository; this.branch=branch; this.runId=runId;
    this.token=token; this.fetchImpl=fetchImpl; this.pending=Promise.resolve(); this.blobs=new Set(); this.cached=null;
    this.base=`https://api.github.com/repos/${repository}`;
    this.ref=branch.split('/').map(segment).join('/');
  }
  _serial(operation) {
    const task=this.pending.catch(()=>{}).then(operation); this.pending=task; return task;
  }
  async _request(method,route,body) {
    if(typeof this.token!=='string'||!this.token.trim()) throw new Error('GITHUB_TOKEN is required for durable persistence');
    let response;
    try {
      response=await this.fetchImpl(this.base+route,{method,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.token}`,'X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    } catch { throw new Error('GitHub persistence transport failed'); }
    if(!response?.ok) throw new GitHubError(Number.isInteger(response?.status)?response.status:0);
    try { return await response.json(); } catch { throw new Error('GitHub returned an invalid persistence response'); }
  }
  _result(commit,extra={}) {
    return {branch:this.branch,commit,url:commit?`https://github.com/${this.repository}/tree/${this.ref}/${segment(this.runId)}`:null,...extra};
  }
  async _head() {
    try {
      const ref=await this._request('GET',`/git/ref/heads/${this.ref}`);
      if(ref.ref!==`refs/heads/${this.branch}`||ref.object?.type!=='commit') throw new Error('GitHub returned an invalid data branch');
      return sha(ref.object.sha);
    } catch(error) {
      if(error.status!==404) throw error;
      // A masked repository/authentication 404 is never treated as an absent branch.
      await this._request('GET','');
      const matches=await this._request('GET',`/git/matching-refs/heads/${this.ref}`);
      if(!Array.isArray(matches)) throw new Error('GitHub returned invalid branch references');
      const match=matches.find(ref=>ref.ref===`refs/heads/${this.branch}`);
      if(match) {
        if(match.object?.type!=='commit') throw new Error('GitHub returned an invalid data branch');
        return sha(match.object.sha);
      }
      return null;
    }
  }
  async _tree(id) {
    const result=await this._request('GET',`/git/trees/${sha(id)}`);
    if(result.sha!==id||result.truncated||!Array.isArray(result.tree)||result.tree.length>MAX_FILES) throw new Error('GitHub returned an incomplete or oversized data tree');
    for(const entry of result.tree) {
      if(typeof entry.path!=='string'||entry.path.includes('/')||['.','..'].includes(entry.path)||entry.path.includes('\0')) throw new Error('GitHub returned an unsafe data tree');
      sha(entry.sha);
    }
    return result.tree;
  }
  async _remote(head) {
    if(this.cached?.head===head) return this.cached;
    const commit=await this._request('GET',`/git/commits/${sha(head)}`), tree=sha(commit.tree?.sha);
    const root=await this._tree(tree), run=root.find(entry=>entry.path===this.runId), files=new Map();
    if(run) {
      if(run.type!=='tree'||run.mode!=='040000') throw new Error('Remote run prefix is not a directory');
      const entries=await this._tree(run.sha), state=entries.find(entry=>entry.path==='state.json'), images=entries.find(entry=>entry.path==='images');
      if(state) this._entry(files,'state.json',state,STATE_LIMIT);
      if(images) {
        if(images.type!=='tree'||images.mode!=='040000') throw new Error('Remote images prefix is not a directory');
        for(const entry of await this._tree(images.sha)) if(imageName(entry.path)) this._entry(files,'images/'+entry.path,entry,IMAGE_LIMIT);
      }
    }
    const remote={head,tree,files}; this.cached=remote; return remote;
  }
  _entry(files,name,entry,limit) {
    if(entry.type!=='blob'||entry.mode!=='100644') throw new Error('Remote evidence must contain regular files');
    if(entry.size!==undefined&&(!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>limit)) throw new Error('Remote evidence exceeds its size limit');
    files.set(name,{sha:sha(entry.sha),size:entry.size}); this.blobs.add(entry.sha);
  }
  async _initialize() {
    // GitHub's create-tree endpoint rejects an empty tree. Keep this orphan
    // branch independent of application source with one static documentation file.
    const readme=Buffer.from('# Guided classifier evidence\n\nThis branch stores durable classifier evidence. Each run has its own directory containing state.json and immutable images/*.jpg. Interrupted actions require operator review and are never automatically replayed. Access keys and repository tokens must never be stored here.\n');
    const blob=await this._request('POST','/git/blobs',{content:readme.toString('base64'),encoding:'base64'});
    if(sha(blob.sha)!==gitSha(readme)) throw new Error('GitHub bootstrap documentation checksum did not match');
    this.blobs.add(blob.sha);
    const tree=await this._request('POST','/git/trees',{tree:[{path:'README.md',mode:'100644',type:'blob',sha:blob.sha}]});
    const commit=await this._request('POST','/git/commits',{message:'Initialize classifier data',tree:sha(tree.sha),parents:[]});
    try { await this._request('POST','/git/refs',{ref:`refs/heads/${this.branch}`,sha:sha(commit.sha)}); return commit.sha; }
    catch(error) {
      if(![409,422].includes(error.status)) throw error;
      const head=await this._head(); if(head) return head; throw error;
    }
  }
  async _directories(create=false) {
    // Check every existing ancestor; never follow an observed symlink.
    for(const target of [this.directory,path.join(this.directory,'images')]) {
      const parsed=path.parse(target); let current=parsed.root;
      for(const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current=path.join(current,part);
        let info;
        try { info=await lstat(current); }
        catch(error) { if(error.code!=='ENOENT'||!create) throw new Error('Local evidence directory is unavailable'); await mkdir(current,{mode:0o700}); info=await lstat(current); }
        if(!info.isDirectory()||info.isSymbolicLink()) throw new Error('Local evidence directory is unsafe');
      }
    }
  }
  async _read(name,limit) {
    const target=path.join(this.directory,name); let handle;
    try {
      handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
      const info=await handle.stat();
      if(!info.isFile()||info.size<1||info.size>limit) throw new Error('invalid');
      const bytes=await handle.readFile(); if(bytes.length<1||bytes.length>limit) throw new Error('invalid');
      return bytes;
    } catch { throw new Error('Local evidence is unavailable, unsafe or oversized'); }
    finally { await handle?.close(); }
  }
  _validateState(bytes) {
    let state;
    try { state=JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Evidence state is not valid JSON'); }
    if(state?.schemaVersion!==1||state.runId!==this.runId||!Array.isArray(state.games)) throw new Error('Evidence state belongs to a different run or schema');
  }
  async _snapshot() {
    await this._directories();
    const names=['state.json',...(await readdir(path.join(this.directory,'images'))).filter(imageName).sort().map(name=>'images/'+name)];
    if(names.length>MAX_FILES) throw new Error('Too many evidence files');
    const files=new Map(); let total=0;
    for(const name of names) {
      const bytes=await this._read(name,name==='state.json'?STATE_LIMIT:IMAGE_LIMIT); total+=bytes.length;
      if(total>TOTAL_LIMIT) throw new Error('Evidence exceeds the total size limit');
      files.set(name,{bytes,sha:gitSha(bytes)});
    }
    this._validateState(files.get('state.json').bytes);
    return files;
  }
  publish() { return this._serial(()=>this._publish()); }
  async _publish() {
    const files=await this._snapshot();
    let head=await this._head(); if(!head) head=await this._initialize();
    for(let attempt=0;attempt<MAX_ATTEMPTS;attempt++) {
      const remote=await this._remote(head), changes=[];
      for(const [name,file] of files) {
        const previous=remote.files.get(name);
        if(name.startsWith('images/')&&previous&&previous.sha!==file.sha) throw new Error('An immutable screenshot already exists with different bytes');
        if(previous?.sha===file.sha) continue;
        if(!this.blobs.has(file.sha)) {
          const blob=await this._request('POST','/git/blobs',{content:file.bytes.toString('base64'),encoding:'base64'});
          if(sha(blob.sha)!==file.sha) throw new Error('GitHub blob checksum did not match local evidence');
          this.blobs.add(file.sha);
        }
        changes.push({path:`${this.runId}/${name}`,mode:'100644',type:'blob',sha:file.sha});
      }
      if(!changes.length) return this._result(head);
      const tree=await this._request('POST','/git/trees',{base_tree:remote.tree,tree:changes});
      const commit=await this._request('POST','/git/commits',{message:`Save classifier run ${this.runId}`,tree:sha(tree.sha),parents:[head]});
      const next=sha(commit.sha);
      try {
        await this._request('PATCH',`/git/refs/heads/${this.ref}`,{sha:next,force:false});
        const updated=new Map(remote.files); for(const [name,file] of files) updated.set(name,{sha:file.sha,size:file.bytes.length});
        this.cached={head:next,tree:tree.sha,files:updated}; return this._result(next);
      } catch(error) {
        if(![409,422].includes(error.status)) throw error;
        const current=await this._head();
        if(!current||current===head) throw error;
        head=current;
      }
    }
    throw new Error('GitHub data branch changed repeatedly; evidence was not published');
  }
  restore() { return this._serial(()=>this._restore()); }
  async _restore() {
    const head=await this._head(); if(!head) return this._result(null,{restored:false,files:0});
    const remote=await this._remote(head);
    if(!remote.files.has('state.json')) return this._result(head,{restored:false,files:0});
    const files=new Map(); let total=0;
    for(const [name,file] of remote.files) {
      const limit=name==='state.json'?STATE_LIMIT:IMAGE_LIMIT;
      const blob=await this._request('GET',`/git/blobs/${file.sha}`);
      if(blob.sha!==file.sha||blob.encoding!=='base64'||!Number.isSafeInteger(blob.size)||blob.size<1||blob.size>limit||typeof blob.content!=='string'||blob.content.length>Math.ceil(limit/3)*4+Math.ceil(limit/45))
        throw new Error('GitHub returned invalid or oversized evidence');
      const encoded=blob.content.replace(/\s/g,'');
      if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('GitHub returned invalid evidence encoding');
      const bytes=Buffer.from(encoded,'base64');
      if(bytes.length!==blob.size||bytes.length>limit||gitSha(bytes)!==file.sha||(file.size!==undefined&&file.size!==bytes.length)) throw new Error('GitHub evidence checksum or size did not match');
      total+=bytes.length; if(total>TOTAL_LIMIT) throw new Error('Remote evidence exceeds the total size limit');
      files.set(name,bytes);
    }
    this._validateState(files.get('state.json'));
    // Fetch and verify everything before replacing any local state. Write state last.
    await this._directories(true);
    for(const [name,bytes] of [...files].sort(([a],[b])=>Number(a==='state.json')-Number(b==='state.json'))) await this._write(name,bytes);
    return this._result(head,{restored:true,files:files.size});
  }
  async _write(name,bytes) {
    await this._directories(); const target=path.join(this.directory,name), temporary=target+'.'+randomUUID()+'.tmp';
    try { const info=await lstat(target); if(!info.isFile()||info.isSymbolicLink()) throw new Error('Local evidence destination is unsafe'); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    let handle;
    try {
      handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await handle.writeFile(bytes); await handle.close(); handle=null; await rename(temporary,target);
    } catch { throw new Error('Unable to restore local evidence safely'); }
    finally { await handle?.close(); await unlink(temporary).catch(()=>{}); }
  }
}
