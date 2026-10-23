// Pure planning rules shared by the Worker progress view and local executor.
export const isCatalogueOverlayAction=action=>/reject\s+all|rechazar\s+todo|cookies?|consent\s+overlay|privacy\s+(?:notice|dialog)|age\s+gate/i.test((action?.label||'')+' '+(action?.controlPath||''));
const kinds=new Set(['buy','navigate','pick','other']);
export const isNormalClick=action=>Boolean(action)&&kinds.has(action.kind)&&Number.isFinite(action.x)&&Number.isFinite(action.y)&&action.x>=0&&action.x<=1&&action.y>=0&&action.y<=1;
export const hasVisualReference=action=>Boolean(action?.visualReference)&&typeof action.visualReference.itemId==='string'&&action.visualReference.itemId.length<=400&&Number.isInteger(action.visualReference.revision)&&/^[a-f0-9]{64}$/.test(action.visualReference.sourceSha256||'')&&/^[a-f0-9]{64}$/.test(action.visualReference.imageSha256||'');
const key=a=>`${a.state}|${String(a.controlPath||a.label||'').toLowerCase()}|${a.kind}`;
export function reviewedAction(item,index){
 if(item?.status!=='classified'||!item.sourceSha256||!Number.isInteger(item.revision))throw Error('decision must be classified with current revision');
 const selection=item.decisions?.allMarks?.[index];
 if(!isNormalClick(selection))throw Error('invalid classified action');
 const chosen=item.decisions?.selections?.find(s=>s.kind===selection.kind&&s.label===selection.label&&s.x===selection.x&&s.y===selection.y);
 const candidateId=chosen?.candidateId||selection.candidateId;
 const candidate=candidateId?(item.candidates||[]).find(c=>c.id===candidateId):null;
 if(candidateId&&!candidate)throw Error('stale candidate');
 return {kind:selection.kind,label:String(selection.label||candidate?.label||'').slice(0,140),x:selection.x,y:selection.y,state:item.state,...(candidate?.path?{controlPath:candidate.path}:{}),...(candidateId?{candidateId}:{}),
  ...(item.state==='UNKNOWN'&&!candidate?.path&&item.hasImage&&item.imageSha256?{visualReference:{itemId:item.id,revision:item.revision,sourceSha256:item.sourceSha256,imageSha256:item.imageSha256}}:{})};
}
export function eligibleReviewedPath(action,ancestors,{maxDepth=7,allowNormalSpin=false}={}){
 if(!Array.isArray(ancestors)||ancestors.length>=maxDepth||ancestors.length>20)return false;
 if(action.state==='UNKNOWN'&&!action.controlPath&&!hasVisualReference(action))return false;
 if(ancestors.some(isCatalogueOverlayAction)||isCatalogueOverlayAction(action))return false;
 const label=(action.label||'')+' '+(action.controlPath||'');
 const normalized=label.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 if(/^(?:settings|configuracion|informacion|paytable|info|help|ayuda|sound|sonido|autoplay|autojuego|aumentar apuesta|reducir apuesta|disminuir apuesta|increase bet|decrease bet)(?:\s|$)/i.test(normalized.trim()))return false;
 if(!allowNormalSpin&&action.state==='BASE'&&/^(?:girar|spin|jugar|start spin)(?:\s|$)/i.test(normalized.trim()))return false;
 if(/AutoPlay|Settings|Gear|SoundToggle|HelpButton/i.test(label))return false;
 if(!allowNormalSpin&&action.state==='BASE'&&/(?:Spin[_/-]?Normal|Normal[_/-]?Spin|AutoSpin|SpinButton)/i.test(label))return false;
 return !ancestors.some(a=>key(a)===key(action));
}
