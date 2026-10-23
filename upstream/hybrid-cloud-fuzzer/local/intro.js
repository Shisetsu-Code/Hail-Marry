// Only dismiss a verified Pragmatic public DEMO intro; never click in unknown providers.
const KNOWN=/\/IntroScreen\/.*(?:\/StartSpin_Button|\/CloseButton\/ButtonSpin)$/i;
const REJECT=/^reject all$|^rechazar todo$/i;
export {isCatalogueOverlayAction} from '../src/action-plan.js';

function demoTarget(page,provider,url){
 if(provider!=='pragmatic'||typeof url!=='string')return false;
 let target;
 try{target=new URL(url);}catch{return false;}
 if(target.protocol!=='https:'||target.hostname!=='www.pragmaticplay.fun'||!/^\/en\/slots\/[a-z0-9-]+\/$/.test(target.pathname))return false;
 const current=new URL(page.url());
 if(current.origin!==target.origin||current.pathname!==target.pathname)throw Error('Public demo redirected to an unapproved destination');
 return true;
}

// Site-level cookie/age dialogs live in the catalogue page outside the game iframe.
// Fresh Chromium contexts can cause the CMP to reappear after the iframe has attached.
// Reject *only* the known reject-all cookie button, never accept tracking consent,
// and never click an age gate unless the operator authorized adulthood.
export async function dismissCatalogueOverlays(page,{
 provider,url,confirmAdult=false,graceMs=0,requireClear=false
}={}){
 const result={cookiesDismissed:0,ageConfirmed:false};
 if(!demoTarget(page,provider,url))return result;
 const cookie=page.getByRole('button',{name:REJECT}).first();
 const age=page.locator('button[data-age-gate-confirm="true"]').first();
 const visible=async locator=>await locator.count()>0&&await locator.isVisible();
 const sweep=async()=>{
  if(await visible(age)){
   if(!confirmAdult)throw Error('Operator adult age confirmation required (--confirm-adult)');
   demoTarget(page,provider,url);
   await age.click({timeout:5000});
   result.ageConfirmed=true;
  }
  if(await visible(cookie)){
   demoTarget(page,provider,url);
   await cookie.click({timeout:3000});
   result.cookiesDismissed++;
  }
 };
 // No per-process "already dismissed" flag: every context and every recurrence
 // must be checked. Bound repeated CMP failures instead of looping forever.
 let gracePending=graceMs>0;
 for(let attempt=0;attempt<8;attempt++){
  const before=result.cookiesDismissed+Number(result.ageConfirmed);
  await sweep();
  const changed=result.cookiesDismissed+Number(result.ageConfirmed)>before;
  if(changed){if(page.waitForTimeout)await page.waitForTimeout(100);continue;}
  if(gracePending){gracePending=false;if(page.waitForTimeout)await page.waitForTimeout(Math.min(graceMs,2000));continue;}
  break;
 }
 if(requireClear){
  if(await visible(age))throw Error('Adult age gate still blocks the public DEMO');
  if(await visible(cookie))throw Error('Cookie consent overlay still covers the game');
 }
 return result;
}

// A screenshot is observational and may safely be repeated. If the CMP appears
// while it is taken, discard it and re-extract metadata and pixels together.
export async function captureWithoutCatalogueOverlays(page,options,capture){
 for(let attempt=0;attempt<3;attempt++){
  await dismissCatalogueOverlays(page,{...options,graceMs:450,requireClear:true});
  const snapshot=await capture();
  const after=await dismissCatalogueOverlays(page,{...options,graceMs:100,requireClear:true});
  if(!after.cookiesDismissed&&!after.ageConfirmed)return snapshot;
 }
 throw Error('Catalogue overlay repeatedly interrupted capture; screenshot discarded');
}

// Only the public catalogue's DEMO launcher, never a game purchase/spin button.
export async function openPublicDemo(page,{provider,url,confirmAdult=false}={}){
 if(!demoTarget(page,provider,url))return {launched:false};
 const demo=page.locator('iframe[src*="demogamesfree.pragmaticplay.net"]');
 if(await demo.count()){
  await dismissCatalogueOverlays(page,{provider,url,confirmAdult});
  return {launched:false};
 }
 const launch=page.getByRole('button',{name:/^play demo$|^jugar demo$|^probar demo$/i}).first();
 await launch.waitFor({state:'visible',timeout:15000});
 await dismissCatalogueOverlays(page,{provider,url,confirmAdult});
 demoTarget(page,provider,url);
 await launch.click({timeout:10000});
 // The adult dialog may appear only *after* Play Demo was selected.
 await dismissCatalogueOverlays(page,{provider,url,confirmAdult});
 await demo.first().waitFor({state:'visible',timeout:25000});
 // CMP can become visible after iframe initialization.
 await dismissCatalogueOverlays(page,{provider,url,confirmAdult});
 return {launched:true};
}

export function knownIntroCandidate(data){
  if(data?.state!=='INTRO'||data?.adapter!=='pragmatic-runtime')return null;
  const found=(data.candidates||[]).filter(c=>KNOWN.test(c.path||'')&&c.rect&&c.confidence>=0.8);
  return found.length===1?found[0]:null;
}
export async function dismissKnownIntro(page,selected,{inspect,wait=ms=>page.waitForTimeout(ms)}={}){
  const control=knownIntroCandidate(selected?.data);
  if(!control)return {dismissed:false,selected};
  const frame=selected.frame;
  let x,y;
  if(frame===page.mainFrame()){
    const viewport=page.viewportSize();
    if(!viewport)return {dismissed:false,selected};
    x=(control.rect.x+control.rect.w/2)*viewport.width;
    y=(control.rect.y+control.rect.h/2)*viewport.height;
  }else{
    const box=await (await frame.frameElement()).boundingBox();
    const size=await frame.evaluate(()=>({width:innerWidth,height:innerHeight}));
    if(!box||!size||Math.abs(box.width-size.width)>2||Math.abs(box.height-size.height)>2)
      return {dismissed:false,selected};
    x=box.x+(control.rect.x+control.rect.w/2)*box.width;
    y=box.y+(control.rect.y+control.rect.h/2)*box.height;
  }
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0)return {dismissed:false,selected};
  await page.mouse.click(x,y,{delay:50});
  await wait(1000);
  const after=await inspect();
  return {dismissed:after?.data?.state!=='INTRO',selected:after||selected};
}
