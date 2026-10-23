#!/usr/bin/env node
// Multi-provider public DEMO capture. One browser, sequential jobs, ≤3 new games/minute.
// Never purchases, spins or clicks. Unknown canvas UI -> screenshot-backed visual queue.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cli,safeId,safeHttps,readJSON,writeAtomic,RateLimiter,withLock} from './utils.js';
import {bestFrame,screenshotBox} from './select-frame.js';
import {dismissKnownIntro,openPublicDemo,dismissCatalogueOverlays,captureWithoutCatalogueOverlays} from './intro.js';
import {createNetworkRecorder,shouldSaveHar,saveSanitizedHar,validateHarMode} from './har.js';
import {validateSpeed,speedUpGame} from './speed.js';
import {updateDrainRequested} from './update-drain.js';
const args=cli(process.argv.slice(2));
const base=path.resolve(args.out||'outbox');
const listPath=path.resolve(args.manifest||'examples/demos.json');
const limiter=new RateLimiter(path.join(base,'.throttle.json'),{maxPerMinute:Number(args.rate||3)});
const limit=args.limit?Number(args.limit):Infinity;
if(!Number.isInteger(limit)&&limit!==Infinity||limit<0)throw Error('invalid --limit');
if(args.help){console.log('node local/capture.mjs --manifest=examples/demos.json --out=outbox --rate=3 --limit=5 --speed=4 --har=fallback [--headed] [--confirm-adult]');process.exit(0);}
const catalog=JSON.parse(await fs.readFile(listPath,'utf8'));safeId(catalog.runId,'runId');
if(!Array.isArray(catalog.games))throw Error('catalog.games required');
const live=catalog.games.filter(g=>g.enabled!==false);
const headless=args.headed?false:true;
const imageQuality=Number(args.quality||64);
const harMode=validateHarMode(args.har===true?'fallback':String(args.har||'fallback'));
const speed=validateSpeed(args.speed||1);
if(!Number.isInteger(imageQuality)||imageQuality<35||imageQuality>90)throw Error('JPEG quality 35..90');
let {chromium}=await import('playwright');
async function run(){
  const browser=await chromium.launch({headless});
  let success=0,failed=0,done=0;let stop=false;
  const onStop=()=>{stop=true;console.error('Stop requested; finishing current game');};
  process.on('SIGINT',onStop);process.on('SIGTERM',onStop);
  try{
    for(const [i,game] of live.entries()){
      if(stop||done>=limit||await updateDrainRequested())break;
      safeId(game.provider||'unknown','provider');safeId(game.id,'game id');
      const url=safeHttps(game.url),provider=game.provider||'unknown';
      const shotId=safeId(game.shotId||'base','shotId');
      const file=`${catalog.runId}__${provider}__${game.id}__${shotId}`;
      const metaFile=path.join(base,file+'.json'),jpegFile=path.join(base,file+'.jpg');
      if(await fs.stat(metaFile).catch(()=>null))continue;
      await limiter.reserve();if(stop||await updateDrainRequested())break;
      let context,recorder;
      try{
        context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
        if(harMode!=='off')recorder=createNetworkRecorder(context);
        const page=await context.newPage();page.setDefaultNavigationTimeout(40000);
        await page.goto(url,{waitUntil:'domcontentloaded'});
        await openPublicDemo(page,{provider,url,confirmAdult:args['confirm-adult']===true});
        if(speed>1){const early=await bestFrame(page,provider,{forceImage:!!args['always-image']}).catch(()=>null);
          if(early)await speedUpGame(page,early.frame,speed);}
        await page.waitForTimeout(Math.min(Number(args['wait-ms']||6500),25000));
        let inspected=await bestFrame(page,provider,{forceImage:!!args['always-image']});
        // Explicit wait and re-check if a later intro/overlay appears.
        await page.waitForTimeout(1000);
        inspected=await bestFrame(page,provider,{forceImage:!!args['always-image']});
        if(!inspected)throw Error('no page frame');
        if(speed>1)await speedUpGame(page,inspected.frame,speed);
        await dismissCatalogueOverlays(page,{provider,url,confirmAdult:args['confirm-adult']===true,requireClear:true});
        if(provider==='pragmatic'&&inspected.data.state==='INTRO'&&!args['no-skip-intro']){
          const intro=await dismissKnownIntro(page,inspected,{inspect:()=>bestFrame(page,provider,{forceImage:!!args['always-image']})});
          inspected=intro.selected;
          if(speed>1&&inspected?.frame)await speedUpGame(page,inspected.frame,speed);
        }
        // The CMP can appear after the game finishes loading. On an attached
        // demo this only rejects catalogue cookies; it never relaunches a game.
        await openPublicDemo(page,{provider,url,confirmAdult:args['confirm-adult']===true});
        // A delayed catalogue CMP can cover the screenshot even when the iframe is ready.
        const {clip,aligned,image}=await captureWithoutCatalogueOverlays(page,{provider,url,confirmAdult:args['confirm-adult']===true},async()=>{
          inspected=await bestFrame(page,provider,{forceImage:!!args['always-image']});
          if(!inspected)throw Error('no page frame');
          const {clip,aligned}=await screenshotBox(page,inspected.frame);
          const image=await page.screenshot({type:'jpeg',quality:imageQuality,...(clip?{clip}:{})});
          return {clip,aligned,image};
        });
        const width=Math.round(clip?.width||page.viewportSize().width),height=Math.round(clip?.height||page.viewportSize().height);
        // If the frame was clipped/zoomed, its normalized controls do not align to the JPEG.
        if(!aligned){inspected.data={...inspected.data,mode:'visual',candidates:[],adapter:'unaligned-frame',metadata:{...inspected.data.metadata,frameNotAligned:true}};}
        const info={runId:catalog.runId,provider,gameId:game.id,shotId,state:inspected.data.state,mode:inspected.data.mode,
          adapter:inspected.data.adapter,adapterVersion:inspected.data.adapterVersion,candidates:inspected.data.candidates,
          width,height,metadata:{url,opaqueCanvas:inspected.data.metadata.opaqueCanvas,frameUrl:inspected.frame.url(),
            collectedAt:new Date().toISOString(),imageRef:file+'.jpg',frameAligned:aligned,captureNotes:'DEMO; only a verified Pragmatic intro may be dismissed; no feature purchases or spins are automated'}};
        // HAR is saved only for fallback/unknown screens unless explicitly --har=all.
        // Only a sanitized endpoint/action summary is forwarded as item metadata.
        if(recorder){const diagnostics=await recorder.finish();recorder=null;
          if(shouldSaveHar(harMode,info.mode,info.state)){
            const harFile=`diagnostics/${file}.har`;
            await saveSanitizedHar(path.join(base,harFile),diagnostics.har);
            info.metadata.networkDiagnostics={format:'sanitized-har-1.2',file:harFile,summary:diagnostics.summary};
          }
        }
        if(speed>1)info.metadata.browserSpeed={factor:speed,scope:'game-frame-timers-and-animation',networkAccelerated:false};
        // Screenshot is kept locally for all items; remote upload uses it only for visual/hybrid by default.
        await fs.mkdir(base,{recursive:true});
        await fs.writeFile(jpegFile+'.tmp',image);await fs.rename(jpegFile+'.tmp',jpegFile);
        await writeAtomic(metaFile,info);
        success++;done++;
        console.log(`[${success}] ${provider}/${game.id} ${info.mode} ${info.candidates.length} controls (${info.state})`);
      }catch(e){
        if(recorder){try{const diagnostic=await recorder.finish();recorder=null;
          if(harMode!=='off'&&diagnostic.har.log.entries.length)await saveSanitizedHar(path.join(base,'diagnostics',file+'.failed.har'),diagnostic.har);
        }catch{}}
        failed++;done++;console.error(`FAILED ${provider}/${game.id}: ${e.message}`);}
      finally{await context?.close().catch(()=>{});}
    }
  }finally{process.off('SIGINT',onStop);process.off('SIGTERM',onStop);await browser.close();}
  console.log(`RESULT captured=${success} failed=${failed} output=${base}`);
}
// Dynamic catalog tickets can run for different games concurrently. The shared
// .throttle.json still enforces the existing global rate of 3 starts/minute.
const isolated=args['isolated-job']===true;
if(isolated&&(live.length!==1||!live[0]?.id||!live[0]?.provider))throw Error('--isolated-job requires exactly one provider/game');
const lock=isolated?path.join(base,'.locks','catalog-'+safeId(live[0].provider)+'-'+safeId(live[0].id)+'.lock'):path.join(base,'.capture.lock');
await withLock(lock,run);
