import {bestFrame} from './select-frame.js';

// A runtime may already report BASE while its splash/progress canvas has no
// controls. A fixed delay cannot distinguish that from a loaded game.
export async function waitForCaptureReady(page,provider,{
 inspect=bestFrame,cleanup=async()=>{},sleep=ms=>page.waitForTimeout(ms),
 timeoutMs=60000,pollMs=500
}={}){
 const deadline=Date.now()+timeoutMs;
 for(let attempt=0;;attempt++){
  await cleanup();
  const selected=await inspect(page,provider);
  const data=selected?.data;
  const loading=!selected||data.state==='LOADING'||data.metadata?.roundPhase==='loading'||(provider==='pragmatic'&&(
   (data.candidates?.length??0)===0&&
   (data.adapter==='pragmatic-runtime'||data.metadata?.opaqueCanvas===true)
  ));
  if(!loading)return selected;
  // Attempt cap also bounds injected clocks/sleep implementations in tests.
  if(Date.now()>=deadline||attempt>=Math.ceil(timeoutMs/pollMs))
   throw Error('Game still loading; ready controls not observed, capture discarded');
  await sleep(Math.min(pollMs,Math.max(0,deadline-Date.now())));
 }
}
