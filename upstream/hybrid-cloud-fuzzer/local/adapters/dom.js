// Generic HTML/DOM adapter: valid for any provider with accessible document controls.
// Evaluated inside a browser frame. Must not depend on Node imports or globals.
export function inspectDOM(){
  const rectOf=el=>{const r=el.getBoundingClientRect(),w=innerWidth,h=innerHeight;
    if(!w||!h||r.width<7||r.height<7||r.right<=0||r.bottom<=0||r.left>=w||r.top>=h)return null;
    const x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(w,r.right),bottom=Math.min(h,r.bottom);
    if(right<=x||bottom<=y)return null;
    return {x:x/w,y:y/h,w:(right-x)/w,h:(bottom-y)/h};
  };
  const path=el=>{const parts=[];for(let p=el,n=0;p&&p.nodeType===1&&n<8;p=p.parentElement,n++){
    const idx=p.parentElement?[...p.parentElement.children].indexOf(p)+1:1;
    parts.unshift(p.tagName.toLowerCase()+(p.id?'#'+p.id:'')+':nth-child('+idx+')');}
    return parts.join(' > ');
  };
  const q='button,[role="button"],[role="menuitem"],[role="option"],[role="switch"],input[type="button"],input[type="submit"],a[href],select';
  const nodes=[...document.querySelectorAll(q)].slice(0,600),items=[];
  for(const el of nodes){
    const style=getComputedStyle(el);
    if(style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0||el.disabled||el.getAttribute('aria-disabled')==='true')continue;
    const rect=rectOf(el);if(!rect)continue;
    const cx=(rect.x+rect.w/2)*innerWidth,cy=(rect.y+rect.h/2)*innerHeight;
    const top=document.elementFromPoint(cx,cy);
    if(top&&!el.contains(top)&&!top.contains(el))continue;
    const name=(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||el.value||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,180);
    const role=el.getAttribute('role')||el.tagName.toLowerCase();
    const p=path(el);
    items.push({label:name||role,role,rect,source:'dom',confidence:name?0.88:0.56,path:p});
    if(items.length===220)break;
  }
  const canvas=[...document.querySelectorAll('canvas')].some(c=>{const r=c.getBoundingClientRect();return r.width*r.height>innerWidth*innerHeight*.23;});
  const text=(document.body?.innerText||'').slice(0,6000);
  const labels=items.map(c=>c.label.trim());
  const busy=[...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(el=>rectOf(el)&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none');
  let state='UNKNOWN',roundPhase='unknown';
  const blockedReason=/\b(?:please log in|session expired|sesion (?:expirada|caducada))\b/i.test(text)?'session-expired':null;
  if(blockedReason){state='OTHER';roundPhase='blocked';}
  else if(/\b(?:free spins (?:left|remaining)|tiradas gratis restantes)\s*[:\-]?\s*[1-9]\d*\b/i.test(text)){state='BONUS';roundPhase='active';}
  else if(busy){state='LOADING';roundPhase='loading';}
  else if(/\b(?:confirm purchase|confirmar compra)\b/i.test(text)&&labels.some(s=>/^(?:confirm|confirmar|yes|si|ok)$/i.test(s))){state='CONFIRM';roundPhase='awaiting_confirmation';}
  else if(labels.some(s=>/^stop$/i.test(s))){state='BASE';roundPhase='spinning';}
  else if(/\b(?:total win|you won|premio total)\b/i.test(text)&&labels.some(s=>/^(?:collect|continue|click to continue|tap to continue|cobrar|continuar)$/i.test(s))){state='BONUS';roundPhase='result';}
  else if(/\b(?:free spins|bonus|tiradas gratis)\b/i.test(text)&&labels.some(s=>/^(?:start free spins|start bonus|iniciar bonus)$/i.test(s))){state='BONUS';roundPhase='awaiting_start';}
  else if(labels.some(s=>/^(?:spin|girar|start spin)$/i.test(s))&&!canvas){state='BASE';roundPhase='idle';}
  return {adapter:'generic-dom',adapterVersion:'2',state,roundPhase,...(blockedReason?{blockedReason}:{}),opaqueCanvas:canvas,candidates:items};
}
