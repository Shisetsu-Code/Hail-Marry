import test from 'node:test';
import assert from 'node:assert/strict';
import {knownIntroCandidate,dismissKnownIntro} from '../local/intro.js';
import * as intro from '../local/intro.js';
const sample={state:'INTRO',adapter:'pragmatic-runtime',candidates:[{confidence:.92,path:'Root/IntroScreen/content/IntroButtons/SpinButtons/StartSpin_Button',rect:{x:.7,y:.6,w:.12,h:.15}}]};
test('Pragmatic known intro is dismissed exactly once and resulting state is checked',async()=>{
  let clicks=0;const frame={};const page={mainFrame:()=>frame,viewportSize:()=>({width:1000,height:500}),mouse:{click:async(x,y)=>{clicks++;assert.ok(x>700&&x<900);assert.ok(y>300&&y<450);}}};
  const result=await dismissKnownIntro(page,{frame,data:sample},{inspect:async()=>({frame,data:{state:'BASE',adapter:'pragmatic-runtime'}}),wait:async()=>{}});
  assert.equal(result.dismissed,true);assert.equal(clicks,1);
});
test('never click unknown providers or multiple intro candidates',async()=>{
  const f={};let clicked=false;const page={mainFrame:()=>f,viewportSize:()=>({width:1000,height:600}),mouse:{click:async()=>{clicked=true;}}};
  assert.equal(knownIntroCandidate({...sample,adapter:'generic-dom'}),null);
  assert.equal(knownIntroCandidate({...sample,candidates:[...sample.candidates,...sample.candidates]}),null);
  const result=await dismissKnownIntro(page,{frame:f,data:{...sample,adapter:'generic-dom'}},{inspect:async()=>{throw Error('Should never inspect again');}});
  assert.equal(result.dismissed,false);assert.equal(clicked,false);
});
function landingPage({hasDemo=false,attach=true,ageGate=false,currentUrl='https://www.pragmaticplay.fun/en/slots/game/'}={}){
 const clicks=[];let attached=hasDemo,cookieVisible=true;
 const locator=name=>({count:async()=>name==='iframe'?Number(attached):name==='demo'?1:name==='reject'?Number(cookieVisible):name==='age'?Number(ageGate&&!attached):0,first(){return this;},isVisible:async()=>name==='reject'?cookieVisible:name==='age'?ageGate&&!attached:true,
  click:async()=>{
   clicks.push(name);
   if(name==='reject')cookieVisible=false;
   if(name==='demo')cookieVisible=true; // CMP can reappear when the demo iframe attaches.
   if((name==='demo'&&!ageGate||name==='age')&&attach)attached=true;
  },waitFor:async()=>{if(name==='iframe'&&!attached)throw Error('demo not attached');}});
 return {clicks,url:()=>currentUrl,locator:selector=>locator(selector.startsWith('iframe')?'iframe':selector.includes('data-age-gate-confirm')?'age':'none'),getByRole:(_role,{name})=>locator(name.test('Reject All')?'reject':name.test('Play Demo')?'demo':'none')};
}
test('Pragmatic landing opens its public demo before capture instead of queuing the catalog page',async()=>{
 assert.equal(typeof intro.openPublicDemo,'function');
 const page=landingPage({currentUrl:'https://www.pragmaticplay.fun/en/slots/3-buzzing-wilds/'});const result=await intro.openPublicDemo(page,{provider:'pragmatic',url:'https://www.pragmaticplay.fun/en/slots/3-buzzing-wilds/'});
 assert.equal(result.launched,true);assert.deepEqual(page.clicks,['reject','demo','reject']);
});
test('Public demo launcher never clicks unknown hosts or already attached games',async()=>{
 assert.equal(typeof intro.openPublicDemo,'function');
 for(const url of ['https://casino.example/en/slots/game/','https://www.pragmaticplay.fun.evil.example/en/slots/game/']){
  const page=landingPage();await intro.openPublicDemo(page,{provider:'pragmatic',url});assert.deepEqual(page.clicks,[]);
 }
 const page=landingPage({hasDemo:true});const result=await intro.openPublicDemo(page,{provider:'pragmatic',url:'https://www.pragmaticplay.fun/en/slots/game/'});assert.equal(result.launched,false);assert.ok(!page.clicks.includes('demo'));
});
test('Missing demo iframe fails capture instead of publishing a promotional-page screenshot',async()=>{
 assert.equal(typeof intro.openPublicDemo,'function');
 await assert.rejects(intro.openPublicDemo(landingPage({attach:false}),{provider:'pragmatic',url:'https://www.pragmaticplay.fun/en/slots/game/'}),/demo/i);
});
test('Age gate is acknowledged only after the operator explicitly confirms adulthood',async()=>{
 const options={provider:'pragmatic',url:'https://www.pragmaticplay.fun/en/slots/game/'};
 const unconfirmed=landingPage({ageGate:true});await assert.rejects(intro.openPublicDemo(unconfirmed,options),/adult|age/i);assert.ok(!unconfirmed.clicks.includes('age'));
 const confirmed=landingPage({ageGate:true});assert.equal((await intro.openPublicDemo(confirmed,{...options,confirmAdult:true})).launched,true);assert.ok(confirmed.clicks.includes('age'));
});
test('Redirected catalogue pages cannot trigger demo or age-gate clicks on another destination',async()=>{
 for(const currentUrl of ['https://casino.example/en/slots/game/','https://www.pragmaticplay.fun/en/slots/other-game/']){
  const page=landingPage({currentUrl});await assert.rejects(intro.openPublicDemo(page,{provider:'pragmatic',url:'https://www.pragmaticplay.fun/en/slots/game/',confirmAdult:true}),/redirect|destination/i);assert.deepEqual(page.clicks,[]);
 }
});
