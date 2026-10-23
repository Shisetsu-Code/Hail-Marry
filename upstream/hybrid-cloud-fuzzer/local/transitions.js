import {bestFrame} from './select-frame.js';

const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().split(/\s+\/\s+/)[0];
const continuation=/^(?:continue|click to continue|tap to continue|click anywhere to continue|tap anywhere to continue|collect(?: win(?:nings)?| prize)?|continuar|recoger(?: premio)?|cobrar(?: premio)?|start (?:free spins|bonus)|iniciar (?:tiradas gratis|bonus))$/;
const confirmation=/^(?:confirm|confirm purchase|yes|ok|aceptar|confirmar(?: compra)?|si)$/;
function actionable(c){const r=c?.rect;return c.confidence>=.8&&r&&[r.x,r.y,r.w,r.h].every(Number.isFinite)&&r.w>0&&r.h>0&&r.x>=0&&r.y>=0&&r.x+r.w<=1.001&&r.y+r.h<=1.001;}

// Semantic controls only. A canvas with no known state is a classification task,
// never an excuse to guess a click, repeat a purchase, or spin automatically.
export function transitionDecision(selected,{purchaseAuthorized=false}={}){
 const data=selected?.data;
 if(!data)return {kind:'wait',reason:'no-frame'};
 const phase=data.metadata?.roundPhase;
 if(phase==='blocked')return {kind:'review',reason:data.metadata?.blockedReason||'game-blocked'};
 if(data.state==='LOADING'||['loading','active','spinning'].includes(phase))return {kind:'wait',reason:phase||'loading'};
 if(phase==='choice')return {kind:'review',reason:'unknown-choice'};
 const candidates=(data.candidates||[]).filter(actionable);
 let allowed=[];
 if(data.state==='CONFIRM'||phase==='awaiting_confirmation'){
  if(!purchaseAuthorized)return {kind:'review',reason:'confirmation-without-reviewed-purchase'};
  allowed=candidates.filter(c=>confirmation.test(normalize(c.label))||/\/(?:BuyWindow\/Content\/.*\/Buttons\/ButtonYes|ConfirmWindow\/Buttons\/Button_Yes)$/i.test(c.path||''));
 }else if(['awaiting_start','result'].includes(phase)){
  allowed=candidates.filter(c=>continuation.test(normalize(c.label))||(phase==='result'&&/\/FreeSpins\/Banner\/.*\/ButtonContinue$/i.test(c.path||'')&&/you have won|total win/i.test(c.label))||/(?:\/FSWindows\/(?:FSStart|FSResult)\/ButtonContinue|\/FreeSpins\/Banner\/Content\/Animated\/Texts\/FreeSpins\/(?:Start|Result)\/ButtonContinue)$/i.test(c.path||''));
 }else if(data.state==='BASE'&&phase==='idle')return {kind:'idle'};
 else if(data.state==='BONUS')return {kind:'review',reason:'unknown-bonus-screen'};
 else if(['BUY_MENU','INTRO','CONFIRM'].includes(data.state)||candidates.length)return {kind:'screen'};
 else return {kind:'review',reason:'unknown-screen'};
 return allowed.length===1?{kind:'click',control:allowed[0],reason:phase||'confirmation'}:{kind:'review',reason:allowed.length?'ambiguous-continuation':'unknown-continuation'};
}

export async function settleGame(page,provider,{
 inspect=bestFrame,cleanup=async()=>{},click=async()=>{throw Error('continuation click unavailable');},
 sleep=ms=>page.waitForTimeout(ms),now=Date.now,pollMs=500,timeoutMs=180000,minIdleMs=2000,
 purchaseAuthorized=false,expectedState=null,priorRoundObserved=false,priorResultObserved=false,onObservation=async()=>{}
}={}){
 if(!Number.isFinite(timeoutMs)||timeoutMs<1||!Number.isFinite(pollMs)||pollMs<1||!Number.isFinite(minIdleMs)||minIdleMs<0)throw Error('invalid transition wait limits');
 const started=now(),actions=[],states=[],clicked=new Map();let idleSince=null,lastKey=null,lastStage=null,observedRound=priorRoundObserved,observedResult=priorResultObserved,selected=null;
 const finish=(outcome,reason)=>({outcome,reason,completed:outcome==='completed',elapsedMs:now()-started,observedRound,observedResult,actions,states,selected});
 for(let attempt=0;attempt<=Math.ceil(timeoutMs/pollMs);attempt++){
  await cleanup();selected=await inspect(page,provider);await onObservation(selected);
  const data=selected?.data,phase=data?.metadata?.roundPhase;
  const stage=JSON.stringify([data?.state,phase]);
  if(stage!==lastStage){clicked.clear();lastStage=stage;}
  const stateKey=JSON.stringify([data?.state,phase,(data?.candidates||[]).map(c=>[c.path,c.label])]);
  if(stateKey!==lastKey){idleSince=null;lastKey=stateKey;if(states.length<16)states.push({state:data?.state||'UNKNOWN',phase:phase||'unknown',atMs:now()-started});}
  if(['active','spinning','result'].includes(phase))observedRound=true;
  if(phase==='result')observedResult=true;
  if(expectedState&&data?.state===expectedState&&!['loading','active','spinning'].includes(phase))return finish('next_screen','next-reviewed-step');
  const decision=transitionDecision(selected,{purchaseAuthorized});
  if(decision.kind==='click'){
   const control=decision.control,key=JSON.stringify([control.path,control.label]);
   if(clicked.has(key)){
    if(now()-clicked.get(key)>=2000)return finish('needs_review','continuation-did-not-change-screen');
   }else{
    if(actions.length>=8)return finish('needs_review','continuation-budget');
    await click(control,selected);clicked.set(key,now());
    actions.push({label:control.label.slice(0,140),path:control.path?.slice(0,160)||null,rect:control.rect,state:data.state,phase:phase||'unknown',atMs:now()-started});
   }
   idleSince=null;
  }else if(decision.kind==='review')return finish('needs_review',decision.reason);
  else if(['idle','screen'].includes(decision.kind)){
   idleSince??=now();
   if(now()-idleSince>=minIdleMs){
    if(decision.kind==='idle'&&purchaseAuthorized&&observedRound&&!observedResult)return finish('needs_review','purchase-result-not-observed');
    return finish(decision.kind==='idle'&&observedRound?'completed':'next_screen',decision.kind==='idle'?'stable-idle':'stable-screen');
   }
  }else idleSince=null;
  if(now()-started>=timeoutMs)break;
  await sleep(Math.min(pollMs,Math.max(0,timeoutMs-(now()-started))));
 }
 return finish('timeout','game-did-not-settle');
}
