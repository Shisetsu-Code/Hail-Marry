import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserRunner } from './runner.mjs';
import { GuidedStore, sanitizeEvidence } from './store.mjs';
import { createClassifierServer } from './server.mjs';
import { RepositoryPublisher } from './publisher.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args={};
for(let i=2;i<process.argv.length;i++) {
  const key=process.argv[i].replace(/^--/,'');
  args[key]=process.argv[i+1]?.startsWith('--')||!process.argv[i+1]?true:process.argv[++i];
}
const config=JSON.parse(await readFile(path.resolve(root,args.config||'config/classifier-session.json'),'utf8'));
const directory=path.resolve(root,args.data||`artifacts/classifier-data/${config.runId}`);
const port=Number(args.port||process.env.PORT||8767);
if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid port');
await mkdir(directory,{recursive:true});
let fixtureServer;
let targets;
if(args.fixture) {
  const html=await readFile(path.join(root,'classifier/fixtures/game.html'));
  fixtureServer=http.createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end(html);});
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
  targets=['fixture-one','fixture-two'].map(id=>({id,title:id==='fixture-one'?'Fixture de integración':'Fixture Solo Spin',provider:'fixture',url:`http://127.0.0.1:${fixtureServer.address().port}/game.html`}));
} else {
  const manifest=JSON.parse(await readFile(path.resolve(root,config.manifest||'config/demos.json'),'utf8'));
  targets=manifest.demos;
  if(!Array.isArray(targets)||!targets.length) throw new Error('Demo manifest is empty');
}
const publisher=process.env.GITHUB_TOKEN && !args.fixture ? new RepositoryPublisher({directory,
  repository:process.env.GITHUB_REPOSITORY||'Shisetsu-Code/Hail-Marry',branch:config.dataBranch||'classifier-data',runId:config.runId}) : null;
if(publisher) await publisher.restore();
const store=await GuidedStore.open({directory,runId:config.runId,targets,onSaved:publisher?()=>publisher.publish():null});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||undefined,
  args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const runner=new BrowserRunner({browser,targets,initialWaitMs:args.fixture?0:60000,settleMs:args.fixture?100:1500,localFixture:Boolean(args.fixture)});
const server=createClassifierServer({store,runner,tokenHash:process.env.CLASSIFIER_TOKEN_HASH||config.tokenHash,publicDir:path.join(root,'classifier/public')});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
console.log(JSON.stringify({type:'classifier-ready',port,runId:config.runId,persistence:publisher?'github':'local'}));
let closing=false;
async function shutdown() {
  if(closing) return;
  closing=true;
  await new Promise(resolve=>{server.close(resolve);setTimeout(()=>{server.closeAllConnections();resolve();},10000).unref();});
  await runner.close();
  await store.checkpoint().catch(()=>{});
  await writeFile(path.join(directory,'routes.json'),JSON.stringify(store.export(),null,2)+'\n');
  await browser.close();
  if(fixtureServer) await new Promise(resolve=>fixtureServer.close(resolve));
}
process.once('SIGTERM',()=>shutdown().then(()=>process.exit(0)));
process.once('SIGINT',()=>shutdown().then(()=>process.exit(0)));
await Promise.allSettled(targets.filter(target=>!store.game(target.id).finished).map(async target=>{
  try {
    await store.setGame(target.id,{status:'loading',busy:false,error:null,screen:null});
    const observation=await runner.open(target.id);
    await store.capture(target.id,observation);
    await store.setGame(target.id,{requiresReview:false});
    await store.checkpoint();
    console.log(JSON.stringify({type:'capture-ready',gameId:target.id}));
  } catch(error) {
    await store.setGame(target.id,{status:'failed',busy:false,error:String(error.message).slice(0,300)}).catch(()=>{});
    console.log(JSON.stringify({type:'capture-failed',gameId:target.id,message:sanitizeEvidence(String(error.message).slice(0,240))}));
  }
}));
