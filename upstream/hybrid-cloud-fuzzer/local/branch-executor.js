// Local Playwright-only public DEMO branch executor. Never runs on Cloudflare.
import {bestFrame,screenshotBox} from './select-frame.js';
import {waitForCaptureReady} from './capture-ready.js';
import {openPublicDemo,dismissKnownIntro,dismissCatalogueOverlays,captureWithoutCatalogueOverlays,isCatalogueOverlayAction} from './intro.js';
import {speedUpGame,speedInit} from './speed.js';
import {createNetworkRecorder,summarizeHar} from './har.js';
import {chooseAction,resolveDemoUrl,classifyTrace,traceEndpoints} from './rounds.js';
import {settleGame} from './transitions.js';
import {matchReviewedImage} from './visual-match.js';

export function screenPoint(point,{clip,aligned},viewport){
 if(!aligned)throw Error('frame alignment uncertain; refusing click');
 if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<0||point.x>1||point.y<0||point.y>1)throw Error('click coordinates outside normalized viewport');
 const box=clip||{x:0,y:0,width:viewport?.width??0,height:viewport?.height??0};
 if(!(box.width>0&&box.height>0))throw Error('invalid game viewport');
 return {x:Math.round((box.x+point.x*box.width)*1000)/1000,y:Math.round((box.y+point.y*box.height)*1000)/1000};
}
export function actionEvidence(har){return {status:classifyTrace(har),endpoints:traceEndpoints(har),actions:summarizeHar(har).actions,validated:false};}
export async function executeDemoBranch(task,source,{
 chromium,browser=null,manifest=[],waitMs=750,speed=1,headless=true,confirmAdult=false,log=console.log,
 openDemo=openPublicDemo,inspect=bestFrame,frameBox=screenshotBox,recorderFactory=createNetworkRecorder,beforeClick=async()=>{},
 transitionWaitMs=180000,controlWaitMs=60000,settle=settleGame,keepAlive=async()=>{},loadReviewedImage=null,matchImage=matchReviewedImage,
 resolveUrl=resolveDemoUrl,cleanupOverlays=dismissCatalogueOverlays
}={}){
 if(!browser&&!chromium?.launch)throw Error('Playwright Chromium required');
 if(task.path.some(isCatalogueOverlayAction))throw Error('Catalogue consent is not a reviewed game branch');
 const url=resolveUrl(source,{catalog:manifest});
 const ownsBrowser=!browser;
 const activeBrowser=browser||await chromium.launch({headless});let context,recorder,actionIssued=false;
 try{
  context=await activeBrowser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
  if(speed>1)await context.addInitScript(speedInit,speed);
  let page=await context.newPage();page.setDefaultNavigationTimeout(45000);
  const response=await page.goto(url,{waitUntil:'domcontentloaded'});
  if(response&&response.status()>=400)throw Error('public DEMO HTTP '+response.status());
  const opened=await openDemo(page,{provider:task.provider,url,confirmAdult});
  if(opened?.page)page=opened.page;
  await page.waitForTimeout(Math.min(waitMs*2,6000));
  // The public catalogue CMP often appears only after the game iframe loads.
  // Do not click the game while its site-level consent/age dialog is visible.
  await cleanupOverlays(page,{provider:task.provider,url,confirmAdult,graceMs:450,requireClear:true});
  let observed=null,settled=null,executedSteps=0;const transitions=[],references=new Map();
  const replayPath=task.path.map(step=>({...step}));
  const lastStep=replayPath.at(-1);
  // Older visual classifications used BASE even for opaque canvases. Bind those
  // manual marks to their reviewed image without changing existing task IDs.
  if(lastStep&&!lastStep.controlPath&&source.hasImage&&source.imageSha256&&!lastStep.visualReference)
   lastStep.visualReference={itemId:source.id,revision:source.revision,sourceSha256:source.sourceSha256,imageSha256:source.imageSha256};
  const visualMatch=async(step,selected,box)=>{
   if(!step.visualReference)return false;
   if(!loadReviewedImage)throw Error('visual reference loader required');
   const key=JSON.stringify(step.visualReference);
   if(!references.has(key))references.set(key,loadReviewedImage(step.visualReference));
   const reference=await references.get(key);
   const image=Buffer.from(await page.screenshot({type:'jpeg',quality:65,...(box.clip?{clip:box.clip}:{})}));
   return (await matchImage(page,reference,image,step)).matched;
  };
  for(let i=0;i<task.path.length;i++){
   const step=replayPath[i];
   if(!['buy','navigate','pick','other'].includes(step.kind))throw Error('unreviewed action type');
   let candidate=null,position=null,shot=null;
   const controlDeadline=Date.now()+controlWaitMs;
   for(let attempt=0;attempt<=Math.ceil(controlWaitMs/500)&&Date.now()<=controlDeadline;attempt++){
    await cleanupOverlays(page,{provider:task.provider,url,confirmAdult,requireClear:true});
    candidate=await waitForCaptureReady(page,task.provider,{inspect,
     cleanup:()=>cleanupOverlays(page,{provider:task.provider,url,confirmAdult,requireClear:true})});
    if(!candidate)throw Error('no game frame');
    if(candidate.data.metadata?.blockedReason)throw Error('DEMO '+candidate.data.metadata.blockedReason);
    if(candidate.data.state==='INTRO'&&step.state!=='INTRO'&&task.provider==='pragmatic'){
     const intro=await dismissKnownIntro(page,candidate,{inspect:()=>inspect(page,task.provider)});
     if(intro.dismissed)candidate=intro.selected;
    }
    shot=await frameBox(page,candidate.frame);
    const visualMatched=shot.aligned&&step.visualReference?await visualMatch(step,candidate,shot):false;
    position=chooseAction(step,i===task.path.length-1?source:null,candidate.data.candidates||[],{aligned:shot.aligned,state:candidate.data.state,visualMatched});
    if(position){
     // Cleanup may replace a frame or reveal a late modal: resolve the current
     // control again before applying any previously extracted coordinates.
     await cleanupOverlays(page,{provider:task.provider,url,confirmAdult,requireClear:true});
     const current=await inspect(page,task.provider);
     if(current){const currentShot=await frameBox(page,current.frame);
      const currentVisualMatched=currentShot.aligned&&step.visualReference?await visualMatch(step,current,currentShot):false;
      const currentPosition=chooseAction(step,i===task.path.length-1?source:null,current.data.candidates||[],{aligned:currentShot.aligned,state:current.data.state,visualMatched:currentVisualMatched});
      if(currentPosition){candidate=current;shot=currentShot;position=currentPosition;break;}
     }
     position=null;
    }
    if(step.visualReference&&attempt>=3)break;
    await page.waitForTimeout(550);
   }
   if(!position){settled={completed:false,outcome:'needs_review',reason:'reviewed-control-or-image-changed'};break;}
   if(speed>1)await speedUpGame(page,candidate.frame,speed);
   // A delayed CMP can appear between extraction and the reviewed click.
   await cleanupOverlays(page,{provider:task.provider,url,confirmAdult,requireClear:true});
   const absolute=screenPoint(position,shot,page.viewportSize());
   // Network observation is scoped to the clicked action, not loading/earlier branches.
   if(!recorder)recorder=recorderFactory(context,{maxEntries:500,maxFrames:200});
   // The pending journal is already durable BEFORE this click. Never silently retry it.
   await beforeClick();
   actionIssued=true;await page.mouse.click(absolute.x,absolute.y,{delay:30});
   executedSteps++;
   await page.waitForTimeout(Math.min(Math.max(waitMs,450),4000));
   const next=task.path[i+1];
   const expectedState=/\/(?:BuyWindow\/Content\/.*\/Buttons\/ButtonYes|ConfirmWindow\/Buttons\/Button_Yes)$/i.test(next?.controlPath||'')?'CONFIRM':/(?:\/FSWindows\/(?:FSStart|FSResult)\/ButtonContinue|\/FreeSpins\/Banner\/Content\/Animated\/Texts\/FreeSpins\/(?:Start|Result)\/ButtonContinue)$/i.test(next?.controlPath||'')?'BONUS':next?.state||null;
   settled=await settle(page,task.provider,{inspect,timeoutMs:transitionWaitMs,onObservation:keepAlive,
    expectedState,priorRoundObserved:transitions.some(t=>t.observedRound),priorResultObserved:transitions.some(t=>t.observedResult),purchaseAuthorized:task.path.slice(0,i+1).some(s=>s.kind==='buy'),
    cleanup:()=>cleanupOverlays(page,{provider:task.provider,url,confirmAdult,requireClear:true}),
    click:async(control,selected)=>{
     const current=await inspect(page,task.provider);
     const matches=current?.data.candidates?.filter(c=>c.path===control.path&&c.label===control.label&&c.confidence>=.8)||[];
     if(current?.data.state!==selected.data.state||matches.length!==1)throw Error('continuation changed before click');
     const box=await frameBox(page,current.frame),r=matches[0].rect;
     const point=screenPoint({x:r.x+r.w/2,y:r.y+r.h/2},box,page.viewportSize());
     await beforeClick();actionIssued=true;await page.mouse.click(point.x,point.y,{delay:30});
    }});
   const {selected:ignored,...transition}=settled;void ignored;
   transitions.push({step:i,...transition});
   log(`CLICK ${task.gameId} ${i+1}/${task.path.length}: ${step.kind} ${step.label}`);
  }
  // Clear late catalogue dialogs before inspecting/cropping the evidence JPEG.
  const {result,box,image}=await captureWithoutCatalogueOverlays(page,{provider:task.provider,url,confirmAdult},async()=>{
   await cleanupOverlays(page,{provider:task.provider,url,confirmAdult,requireClear:true});
   const result=await inspect(page,task.provider);
   if(!result)throw Error('game frame disappeared after reviewed action');
   const box=await frameBox(page,result.frame);
   const image=Buffer.from(await page.screenshot({type:'jpeg',quality:65,...(box.clip?{clip:box.clip}:{})}));
   return {result,box,image};
  });
  if(recorder){observed=await recorder.finish();recorder=null;}
  const width=Math.round(box.clip?.width||page.viewportSize().width),height=Math.round(box.clip?.height||page.viewportSize().height);
  const evidence=actionEvidence(observed?.har||{log:{entries:[],_webSockets:[]}});
  const isAligned=box.aligned;
  const info={runId:task.runId,provider:task.provider,gameId:task.gameId,shotId:task.shotId,
   state:result.data.state,mode:isAligned?(result.data.mode==='structured'?'hybrid':result.data.mode):'visual',adapter:isAligned?result.data.adapter:'unaligned-frame',
   adapterVersion:result.data.adapterVersion||'1',candidates:isAligned?result.data.candidates:[],width,height,
   metadata:{url,parentId:task.parentId,parentSourceSha256:task.parentSourceSha256,parentRevision:task.parentRevision,
    actionPath:replayPath.slice(0,executedSteps),source:'reviewed-branch-executor',frameAligned:isAligned,
    terminal:evidence.status==='bet_request_observed'&&settled?.completed===true,
    roundOutcome:settled?.outcome||'needs_review',...(settled?.reason?{roundReason:settled.reason}:{}),transitions,
    evidenceStatus:evidence.status,networkDiagnostics:{format:'sanitized-har-1.2',summary:observed?.summary||{requests:0,actions:[],endpoints:[]}},
    capturedAt:new Date().toISOString()}};
  if(info.mode==='structured'&&!info.candidates.length)info.mode='visual';
  return {info,image,trace:observed?.har||{log:{version:'1.2',entries:[],_webSockets:[],_notice:'Sanitized DEMO diagnostics.'}}};
 }catch(e){e.actionIssued=actionIssued;throw e;}finally{
  if(recorder)await recorder.finish().catch(()=>{});
  await context?.close().catch(()=>{});if(ownsBrowser)await activeBrowser.close().catch(()=>{});
 }
}
