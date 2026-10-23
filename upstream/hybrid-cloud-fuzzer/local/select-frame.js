// Select the actual game surface instead of a landing page containing many menus.
import {extractFromFrame} from './extract.js';

export function framePriority(data,{embedded=false}={}){
  const semantic=(data.candidates||[]).filter(c=>/buy|bonus|feature|ante|free spins|respins|pick|purchase|options?|collect|continue/i.test(`${c.label} ${c.path||''}`)).length;
  return (data.adapter==='pragmatic-runtime'?350:0)+
    (data.metadata?.opaqueCanvas?180:0)+
    (embedded?75:0)+
    Math.min(semantic,6)*14+Math.min(data.candidates?.length||0,50)+
    (data.state==='INTRO'?15:0);
}
export async function bestFrame(page,provider,{forceImage=false,extract=extractFromFrame}={}){
  const frames=page.frames().filter(f=>!f.isDetached()),main=page.mainFrame();
  const options=[];
  for(const frame of frames){
    const data=await extract(frame,{provider,forceImage});
    options.push({frame,data,weight:framePriority(data,{embedded:frame!==main})});
  }
  options.sort((a,b)=>b.weight-a.weight);
  return options[0]||null;
}

// The screenshot must cover the entire iframe viewport, otherwise hitboxes would
// be normalized in a different coordinate system from the cropped JPEG.
export async function screenshotBox(page,frame){
  if(frame===page.mainFrame())return {clip:null,aligned:true};
  try{
    const box=await (await frame.frameElement()).boundingBox();
    const viewport=page.viewportSize();
    const frameSize=await frame.evaluate(()=>({width:innerWidth,height:innerHeight}));
    if(!box||!viewport||!frameSize?.width||!frameSize?.height)return {clip:null,aligned:false};
    const x=Math.max(0,box.x),y=Math.max(0,box.y);
    const right=Math.min(viewport.width,box.x+box.width),bottom=Math.min(viewport.height,box.y+box.height);
    if(right-x<10||bottom-y<10)return {clip:null,aligned:false};
    const aligned=Math.abs(box.x-x)<1&&Math.abs(box.y-y)<1&&
      Math.abs(box.width-(right-x))<1&&Math.abs(box.height-(bottom-y))<1&&
      Math.abs(box.width-frameSize.width)<2&&Math.abs(box.height-frameSize.height)<2;
    return {clip:{x,y,width:right-x,height:bottom-y},aligned};
  }catch{return {clip:null,aligned:false};}
}
