import fs from 'node:fs/promises';
import path from 'node:path';
const idPattern=/^[a-z0-9][a-z0-9_.-]{0,99}$/i;
export function safeId(s,label='id'){if(typeof s!=='string'||!idPattern.test(s))throw Error(`Invalid ${label}`);return s;}
export async function writeAtomic(file,obj){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify(obj,null,2)+'\n');await fs.rename(tmp,file);}
export async function readJSON(file,fallback=null){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export function cli(args){const options={};for(const arg of args){if(!arg.startsWith('--'))throw Error('Invalid CLI argument '+arg);const index=arg.indexOf('=');options[arg.slice(2,index<0?undefined:index)]=index<0?true:arg.slice(index+1);}return options;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export class RateLimiter{
  constructor(file,{maxPerMinute=3,clock=()=>Date.now(),sleep=pause}={}){
    if(!Number.isInteger(maxPerMinute)||maxPerMinute<1||maxPerMinute>3)throw Error('rate must be 1..3/min');
    this.file=file;this.clock=clock;this.sleep=sleep;this.gap=Math.ceil(60000/maxPerMinute)+150;
  }
  async reserve(){
    for(;;){
      let delay;
      try{delay=await withLock(this.file+'.reserve.lock',async()=>{
        const now=this.clock(),old=await readJSON(this.file,{last:0,starts:[]});
        const starts=(old.starts||[]).filter(t=>Number.isFinite(t)&&t<=now&&t>now-60000).sort((a,b)=>a-b);
        const earliest=starts.length>=3?starts[starts.length-3]+60001:now;
        const next=Math.max(now,(old.last||0)+this.gap,earliest);
        if(next>now)return next-now;
        starts.push(now);await writeAtomic(this.file,{last:now,starts});return 0;
      });}catch(e){
        if(/Capture already running|Unknown collector lock/.test(e.message)){await this.sleep(100);continue;}
        throw e;
      }
      if(delay>0){await this.sleep(delay);continue;}
      return this.clock();
    }
  }
}
export function safeHttps(url){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('only ordinary HTTPS demo URLs allowed');
  const host=u.hostname.toLowerCase();
  if(host==='localhost'||host.endsWith('.local')||host==='0.0.0.0'||host==='::1'||host==='[::1]'||host==='127.0.0.1'||host.startsWith('127.')||host.startsWith('10.')||host.startsWith('192.168.')||host.startsWith('169.254.')||/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host))throw Error('private or local host not allowed');
  return u.href;
}
export async function withLock(file,action){
  await fs.mkdir(path.dirname(file),{recursive:true});let handle;
  for(let i=0;i<2;i++){
    try{handle=await fs.open(file,'wx');break;}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      const stored=Number((await fs.readFile(file,'utf8').catch(()=>'')).trim());
      if(!Number.isSafeInteger(stored)||stored<=0)throw Error(`Unknown collector lock: ${file}`);
      try{process.kill(stored,0);throw Error(`Capture already running (PID ${stored})`);}
      catch(error){if(error.code==='EPERM'||!error.code)throw error;if(error.code!=='ESRCH')throw error;}
      await fs.unlink(file).catch(()=>{});
    }
  }
  if(!handle)throw Error('Could not acquire lock');
  try{await handle.writeFile(String(process.pid));return await action();}
  finally{await handle.close();await fs.unlink(file).catch(()=>{});}
}

