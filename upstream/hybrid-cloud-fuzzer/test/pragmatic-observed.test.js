import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {inspectPragmatic} from '../local/adapters/pragmatic.js';
function inspect(controls){
 const camera={enabled:true,depth:1,cullingMask:1,WorldToScreenPoint:v=>v};
 const XTButton=function(){},Camera=function(){},UILabel=function(){},UISprite=function(){};
 const buttons=controls.map(({path,label})=>{
  let parent=null;
  for(const name of path.split('/'))parent={gameObject:{name,GetComponentsInChildren:()=>[]},parent};
  const go={name:path.split('/').at(-1),activeInHierarchy:true,layer:0,transform:parent,
   collider:{enabled:true,GetTransformedCenterAndSize:()=>({center:{x:500,y:300,z:0},size:{x:200,y:100}})},
   GetComponentsInChildren:type=>type===UILabel?[{gameObject:{activeInHierarchy:true},text:label}]:[]};
  parent.gameObject=go;
  return {gameObject:go,enabled:true,xtEnabled:true};
 });
 const root={GetComponentsInChildren:type=>type===Camera?[camera]:type===XTButton?buttons:[]};
 return vm.runInNewContext('('+inspectPragmatic.toString()+')()',{
  globalRuntime:{sceneRoots:[root]},XTButton,Camera,UILabel,UISprite,
  innerWidth:1280,innerHeight:720,UHTScreen:{width:1280,height:720},
  document:{querySelector:()=>({width:1280,height:720,getBoundingClientRect:()=>({x:0,y:0,width:1280,height:720})})}
 });
}
const stop={path:'Game/GUI/SpinButtons/StopSpin_Button',label:'ananas / ananas_circle'};
test('real misleading StopSpin name is still an active spin',()=>{
 const d=inspect([stop]);assert.equal(d.roundPhase,'spinning');
});
test('observed free spin start overlays take precedence over background StopSpin',()=>{
 for(const path of ['Game/FSWindows/FSStart/ButtonContinue','Game/FreeSpins/Banner/Content/Animated/Texts/FreeSpins/Start/ButtonContinue']){
  const d=inspect([stop,{path,label:'10 / FREE SPINS'}]);assert.equal(d.state,'BONUS');assert.equal(d.roundPhase,'awaiting_start');
 }
});
test('numeric final award is a result while background StopSpin remains active',()=>{
 for(const path of ['Game/FSWindows/FSResult/ButtonContinue','Game/FreeSpins/Banner/Content/Animated/Texts/FreeSpins/Result/ButtonContinue']){
  const d=inspect([stop,{path,label:'$57.00 / IN'}]);assert.equal(d.state,'BONUS');assert.equal(d.roundPhase,'result');
 }
});
test('Wilds variant screen is an explicit choice rather than idle base',()=>{
 const d=inspect([0,1,2].map(n=>({path:`Game/FreeSpins/Bonus/Content/Buttons/B_${n}/Offset/Collider`,label:'WILDS'})));
 assert.equal(d.state,'BONUS');assert.equal(d.roundPhase,'choice');
});
test('confirmation exposes its foreground controls without the background Spin button',()=>{
 const d=inspect([stop,{path:'Game/BuyFeature/ConfirmWindow/Buttons/Button_Yes',label:'buy_feature_yes'},{path:'Game/BuyFeature/ConfirmWindow/Buttons/Button_No',label:'buy_feature_no'}]);
 assert.equal(d.state,'CONFIRM');assert.equal(d.candidates.length,2);
});
