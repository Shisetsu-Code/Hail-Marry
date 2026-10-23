// Pragmatic's public demo runtime (read-only). Other providers do NOT use this adapter.
// Execute in the demo frame with frame.evaluate(inspectPragmatic).
export function inspectPragmatic(){
  const safe=fn=>{try{return fn();}catch{return null;}};
  const roots=globalThis.globalRuntime?.sceneRoots||[];
  const canvas=document.querySelector('canvas');
  if(!canvas||!roots.length)return {supported:false};
  const cr=canvas.getBoundingClientRect();
  const vw=innerWidth,vh=innerHeight;
  const rw=globalThis.UHTScreen?.width||canvas.width;
  const rh=globalThis.UHTScreen?.height||canvas.height;
  const cameraType=globalThis.Camera;
  const cameras=(cameraType?roots.flatMap(r=>safe(()=>r.GetComponentsInChildren(cameraType,true))||[]):[])
    .filter(c=>c.enabled!==false).sort((a,b)=>(b.depth||0)-(a.depth||0));
  const items=[],seen=new Set(),types=['XTButton','CATButton','UIButton'];
  for(const root of roots)for(const type of types){
    const ctor=globalThis[type];if(!ctor)continue;
    for(const button of safe(()=>root.GetComponentsInChildren(ctor,true))||[]){
      const go=button.gameObject;
      if(!go||seen.has(go)||go.activeInHierarchy!==true||button.enabled===false||button.xtEnabled===false||!go.collider||go.collider.enabled===false)continue;
      seen.add(go);
      const segs=[];for(let t=go.transform,n=0;t&&n<22;t=t.parent,n++)segs.unshift(String(t.gameObject?.name||''));
      const path=segs.join('/');
      const labels=[];
      for(let t=go.transform,n=0;t&&n<4;t=t.parent,n++){
        for(const cls of ['UILabel','UISprite']){
          const c=globalThis[cls];if(!c)continue;
          for(const w of safe(()=>t.gameObject.GetComponentsInChildren(c,true))||[]){
            if(w.gameObject?.activeInHierarchy!==true)continue;
            if(typeof w.text==='string'&&w.text.trim())labels.push(w.text.trim().replace(/\s+/g,' ').slice(0,90));
            if(typeof w.spriteName==='string'&&w.spriteName.trim())labels.push(w.spriteName.slice(0,90));
          }
        }
        if(labels.length)break;
      }
      const geom=safe(()=>go.collider.GetTransformedCenterAndSize());
      let rect=null;
      if(geom?.center&&geom?.size){
        const cam=cameras.find(c=>((Number(c.cullingMask)||0)&(1<<go.layer))!==0);
        if(cam){
          const v=geom.center,s=geom.size;
          const points=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>safe(()=>cam.WorldToScreenPoint({x:v.x+x*s.x/2,y:v.y+y*s.y/2,z:v.z})));
          if(points.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y))){
            const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
            const x1=Math.max(0,cr.x+Math.min(...xs)*cr.width/rw),y1=Math.max(0,cr.y+Math.min(...ys)*cr.height/rh);
            const x2=Math.min(vw,cr.x+Math.max(...xs)*cr.width/rw),y2=Math.min(vh,cr.y+Math.max(...ys)*cr.height/rh);
            if(x2>x1&&y2>y1)rect={x:x1/vw,y:y1/vh,w:(x2-x1)/vw,h:(y2-y1)/vh};
          }
        }
      }
      if(rect)items.push({label:[...new Set(labels)].slice(0,2).join(' / ')||go.name||path.split('/').at(-1),path,rect,role:'button',source:'runtime',confidence:0.92});
    }
  }
  const paths=items.map(c=>c.path);
  const finalBanner=items.some(c=>/\/FreeSpins\/Banner\//i.test(c.path)&&/\/ButtonContinue$/i.test(c.path)&&/you have won|total win/i.test(c.label));
  // A bonus may hide every button while still animating. Read its visible
  // counter rather than treating the absence of buttons as a finished screen.
  let remaining=null;
  const labelType=globalThis.UILabel;
  if(labelType)for(const root of roots)for(const widget of safe(()=>root.GetComponentsInChildren(labelType,true))||[]){
    if(widget.gameObject?.activeInHierarchy!==true||typeof widget.text!=='string')continue;
    const name=String(widget.gameObject.name||'');
    if(/(?:free.?spins?|fs).*(?:remaining|left|counter)|(?:remaining|left).*free.?spin/i.test(name)){
      const value=widget.text.replace(/<[^>]*>|\[[^\]]*\]/g,'').trim();
      if(/^\d{1,3}$/.test(value))remaining=Number(value);
    }
  }
  let state=items.length?'BASE':'LOADING';
  if(paths.some(p=>/IntroScreen/i.test(p)))state='INTRO';
  else if(paths.some(p=>/ConfirmPurchaseWindow|FSPurchaseWindow\/content\/Buttons|(?:BuyWindow\/Content\/.*\/Buttons\/ButtonYes|ConfirmWindow\/Buttons\/Button_Yes)$/i.test(p)))state='CONFIRM';
  else if(paths.some(p=>/PurchaseWindow\/content\/Options/i.test(p)))state='BUY_MENU';
  else if(paths.some(p=>/FreeSpins\/(?:Content|Bonus\/Content)|FSWindows\/(?:FSStart|FSResult)|FreeSpins\/Banner|StageResultFreeSpin/i.test(p)))state='BONUS';
  if(remaining>0&&!['INTRO','CONFIRM','BUY_MENU'].includes(state))state='BONUS';
  const label=c=>String(c.label||'').trim().toLowerCase();
  const continuations=items.filter(c=>/^(?:continue|collect(?: win(?:nings)?| prize)?|start (?:free spins|bonus)|click to continue|tap to continue)$/.test(label(c)));
  let roundPhase=state==='LOADING'?'loading':state==='CONFIRM'?'awaiting_confirmation':state==='BASE'?'idle':'unknown';
  if(state==='BONUS'){
    if(paths.some(p=>/\/FreeSpins\/Banner\/Content\/Animated\/Texts\/FreeSpins\/Result\/ButtonContinue$/i.test(p))||finalBanner||paths.some(p=>/StageResultFreeSpin|FreeSpinResult|TotalWinWindow|FSWindows\/FSResult\/ButtonContinue/i.test(p)))roundPhase='result';
    else if(paths.some(p=>/(?:\/FSWindows\/FSStart\/ButtonContinue|\/FreeSpins\/Banner\/Content\/Animated\/Texts\/FreeSpins\/(?:Start|Result)\/ButtonContinue)$/i.test(p))||continuations.length===1)roundPhase='awaiting_start';
    else if(paths.some(p=>/\/FreeSpins\/Bonus\/Content\/Buttons\/B_\d\//i.test(p)))roundPhase='choice';
    else if(items.some(c=>/\b(?:pick|choose|select)\b/i.test(c.label)))roundPhase='choice';
    else if(remaining>0)roundPhase='active';
  }
  if(state==='BASE'&&items.some(c=>/^stop$/i.test(c.label.trim())||/\/StopSpin_Button(?:\/|$)/i.test(c.path)))roundPhase='spinning';
  const foreground=state==='CONFIRM'?items.filter(c=>/ConfirmPurchaseWindow|FSPurchaseWindow|BuyWindow\/Content|ConfirmWindow\/Buttons/i.test(c.path)):items;
  return {supported:true,adapter:'pragmatic-runtime',adapterVersion:'3',state,roundPhase,candidates:foreground.slice(0,250),opaqueCanvas:true};
}
