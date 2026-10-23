// Conservative automatic classification for verified *structured* runtime blocks.
// Visual and hybrid screens remain assigned to human/vision MCP reviewers.
const validRect=r=>r&&Number.isFinite(r.x)&&Number.isFinite(r.y)&&
 Number.isFinite(r.w)&&Number.isFinite(r.h)&&r.w>0&&r.h>0&&r.w<.8&&r.h<.8&&
 r.x>=0&&r.y>=0&&r.x+r.w<=1.001&&r.y+r.h<=1.001;
const trusted=c=>c?.source==='runtime'&&c.confidence>=.9&&validRect(c.rect)&&
 typeof c.path==='string'&&c.path.length>5;
const confirmPath=/(?:\/ButtonYes$|\/ButtonOpt0$|\/Yes\/Button\w+$)/i;
const buyPath=/(?:FeaturePurchase|BuyFeature|BonusPurchase|BuyBonus)/i;
const introPath=/\/IntroScreen\/.*(?:\/StartSpin_Button|\/CloseButton\/ButtonSpin)$/i;

export function classifyStructured(item){
 if(!item||item.mode!=='structured')
  return {eligible:false,reason:'requires structured runtime mode'};
 if(item.adapter!=='pragmatic-runtime')
  return {eligible:true,status:'needs_review',selections:[],reason:'provider runtime not yet validated'};
 const controls=(item.candidates||[]).filter(trusted);
 let chosen=[],kind='navigate';
 if(item.state==='CONFIRM'){
  kind='buy';
  chosen=controls.filter(c=>buyPath.test(c.path)&&confirmPath.test(c.path));
 }else if(item.state==='BASE'){
  kind='buy';
  chosen=controls.filter(c=>buyPath.test(c.path)&&
   /(?:buy|bonus|feature|free spins|respins)/i.test(c.label||'')&&!confirmPath.test(c.path)&&
   !/\/(?:Blocker|ButtonNo|ButtonOpt0)$|\/Buttons\/No\//i.test(c.path));
 }else if(item.state==='INTRO'){
  kind='navigate';
  chosen=controls.filter(c=>introPath.test(c.path));
 }else return {eligible:true,status:'needs_review',selections:[],reason:'unknown structured game state'};
 // Duplicate colliders and ambiguous confirm buttons are not safe to execute.
 if(item.state==='CONFIRM'&&chosen.length!==1)
  return {eligible:true,status:'needs_review',selections:[],reason:'ambiguous confirmation control'};
 if(item.state==='INTRO'&&chosen.length!==1)
  return {eligible:true,status:'needs_review',selections:[],reason:'ambiguous intro control'};
 if(!chosen.length)
  return {eligible:true,status:'needs_review',selections:[],reason:'no high-confidence action'};
 return {eligible:true,status:'classified',selections:chosen.slice(0,20).map(c=>({candidateId:c.id,kind})),
  reason:'verified runtime paths, no visual guessing'};
}
