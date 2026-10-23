import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeDecisions, requiredId } from '../upstream/hybrid-cloud-fuzzer/src/candidates.js';

export class ClassifierError extends Error {
  constructor(message,status=400) { super(message); this.status=status; }
}
export const MODES = Object.freeze({
  spin:{role:'spin',label:'Spin normal',kind:'other'},
  antebet:{role:'antebet',label:'Antebet + Spin',kind:'other'},
  menu:{role:'menu',label:'Menú de compras',kind:'navigate'},
  buy:{role:'buy',label:'Compra directa',kind:'buy'},
  spin_only:{role:'spin',label:'Solo Spin',kind:'other'},
  continue:{role:'continue',label:'Continuar',kind:'navigate'},
  option:{role:'option',label:'Opción',kind:'pick'},
  confirm:{role:'confirm',label:'Confirmar',kind:'buy'},
  cancel:{role:'cancel',label:'Cancelar',kind:'navigate'},
  back:{role:'back',label:'Volver',kind:'navigate'},
  bet:{role:'bet',label:'Apuesta',kind:'other'}
});
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
const now = () => new Date().toISOString();
const secretFields = new Set(['authorization','proxyauthorization','cookie','setcookie','cookies','headers','postdata','requestbody','responsebody','password','secret','token','accesstoken','refreshtoken','apikey','storagestate']);
// Public evidence retains paths and geometry, never session queries or request credentials.
export function sanitizeEvidence(value) {
  if(typeof value==='string') return value.replace(/https?:\/\/[^\s"'<>]+/gi,raw=>{
    try {const url=new URL(raw);return url.origin+url.pathname;}catch{return '[URL omitida]';}
  });
  if(Array.isArray(value)) return value.map(sanitizeEvidence);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value)
    .filter(([key])=>!secretFields.has(key.replace(/[-_]/g,'').toLowerCase()))
    .map(([key,item])=>[key,sanitizeEvidence(item)]));
  return value;
}

export class GuidedStore {
  static async open({directory,runId,targets,onSaved}={}) {
    requiredId(runId,'runId');
    const store = new GuidedStore();
    store.directory=path.resolve(directory); store.onSaved=onSaved; store.pending=Promise.resolve();
    store.persistence={status:'local',savedAt:null,error:null};
    await mkdir(path.join(store.directory,'images'),{recursive:true});
    try {
      store.data=sanitizeEvidence(JSON.parse(await readFile(path.join(store.directory,'state.json'),'utf8')));
      if(store.data.schemaVersion!==1||store.data.runId!==runId||!Array.isArray(store.data.games)) throw new Error('El estado guardado pertenece a otra ejecución o versión');
    } catch(error) {
      if(error.code!=='ENOENT') throw error;
      store.data={schemaVersion:1,runId,revision:0,createdAt:now(),games:[],requests:{}};
    }
    for(const target of targets||[]) {
      requiredId(target.id,'game id');
      if(!store.data.games.some(g=>g.id===target.id)) store.data.games.push({
        id:target.id,title:target.title||target.id,provider:target.provider||'demo',
        status:'loading',busy:false,error:null,finished:false,spinControlId:null,
        screen:null,screens:[],controls:[],actions:[],requiresReview:false
      });
    }
    for(const game of store.data.games) {
      const interrupted=game.actions.filter(action=>action.status==='intent');
      for(const action of interrupted) Object.assign(action,{status:'uncertain',inputDispatched:null,uncertainDispatch:true,
        confirmation:{status:'pending',reason:'La sesión se interrumpió después de guardar la intención; no se conoce si se envió el input.'},updatedAt:now()});
      if(game.busy||interrupted.length) { game.busy=false; game.status='needs_review'; game.requiresReview=true; game.error='La sesión anterior se interrumpió. Revisá una captura nueva antes de seguir.'; }
    }
    for(const request of Object.values(store.data.requests)) if(request.status==='pending')
      Object.assign(request,{status:'failed',httpStatus:409,error:'La solicitud anterior se interrumpió. No se reintentará automáticamente.',updatedAt:now()});
    await store.save();
    return store;
  }
  _game(id) {
    const game=this.data.games.find(g=>g.id===id);
    if(!game) throw new ClassifierError('Juego no encontrado',404);
    return game;
  }
  game(id) { return clone(this._game(id)); }
  state() { return clone({schemaVersion:1,runId:this.data.runId,revision:this.data.revision,games:this.data.games,persistence:this.persistence}); }
  async save({publish=false}={}) {
    this.data.revision++;
    this.data.updatedAt=now();
    const serialized=JSON.stringify(this.data,null,2)+'\n';
    const task=this.pending.catch(()=>{}).then(async()=>{
      const file=path.join(this.directory,'state.json'), temporary=file+'.'+randomUUID()+'.tmp';
      await writeFile(temporary,serialized,{mode:0o600}); await rename(temporary,file);
      this.persistence={status:'local',savedAt:now(),error:null};
      if(publish && this.onSaved) {
        try { const result=await this.onSaved(); this.persistence={status:'published',savedAt:now(),...result,error:null}; }
        catch(error) { this.persistence={status:'error',savedAt:now(),error:'No se pudo publicar el último guardado'}; throw new ClassifierError('No se pudo publicar el guardado. Revisá el estado antes de continuar.',503); }
      }
    });
    this.pending=task;
    await task;
  }
  async checkpoint() { await this.save({publish:true}); return clone(this.persistence); }
  async setGame(id,patch) { Object.assign(this._game(id),sanitizeEvidence(patch)); await this.save(); return this.game(id); }
  assertCurrent(id,reference) {
    const game=this._game(id), screen=game.screen;
    if(!screen || reference?.screenId!==screen.id || reference?.revision!==screen.revision || reference?.imageSha256!==screen.imageSha256)
      throw new ClassifierError('La captura cambió. Actualizá la imagen antes de marcar.',409);
    return screen;
  }
  async capture(id,observation,{parentScreenId=null,viaControlId=null,route=[],uncertainTransition=null}={}) {
    const game=this._game(id);
    if(!Buffer.isBuffer(observation.image)||observation.image.length===0||observation.image.length>12*1024*1024) throw new ClassifierError('Captura inválida');
    if(!observation.sessionId || !Number.isInteger(observation.width)||!Number.isInteger(observation.height)||observation.width<1||observation.height<1) throw new ClassifierError('Identidad o tamaño de captura inválido');
    const coordinateTransform=observation.coordinateTransform||{scale:1,offsetLeft:0,offsetTop:0,
      visualWidth:observation.width,visualHeight:observation.height,layoutWidth:observation.width,layoutHeight:observation.height};
    if(['scale','visualWidth','visualHeight','layoutWidth','layoutHeight'].some(key=>!Number.isFinite(coordinateTransform[key])||coordinateTransform[key]<=0)||
      ['offsetLeft','offsetTop'].some(key=>!Number.isFinite(coordinateTransform[key])||coordinateTransform[key]<0)) throw new ClassifierError('Transformación de coordenadas inválida');
    const imageSha256=hash(observation.image);
    if(observation.imageSha256 && observation.imageSha256!==imageSha256) throw new ClassifierError('El hash de la captura no coincide');
    if(parentScreenId && !game.screens.some(s=>s.id===parentScreenId)) throw new ClassifierError('Pantalla padre ajena al juego');
    if(route.some(controlId=>!game.controls.some(c=>c.id===controlId))) throw new ClassifierError('Ruta con controles ajenos al juego');
    const revision=(game.screens.at(-1)?.revision||0)+1, screenId=randomUUID();
    const filename=`${id}-${revision}-${imageSha256.slice(0,20)}.jpg`;
    await writeFile(path.join(this.directory,'images',filename),observation.image,{flag:'wx',mode:0o600});
    const screen={id:screenId,gameId:id,sessionId:observation.sessionId,revision,imageSha256,
      imageUrl:'/api/images/'+filename,width:observation.width,height:observation.height,coordinateTransform:clone(coordinateTransform),
      createdAt:observation.at||now(),parentScreenId,viaControlId,route:[...route],
      routeVerified:!uncertainTransition && game.screens.find(s=>s.id===parentScreenId)?.routeVerified!==false,
      ...(uncertainTransition?{uncertainTransition:clone(uncertainTransition)}:{}),
      candidates:sanitizeEvidence(observation.candidates||[]),state:sanitizeEvidence(observation.state||{})};
    game.screens.push(screen); game.screen=screen; game.status=game.finished?'classified':'ready'; game.error=null;
    await this.save(); return clone(screen);
  }
  imagePath(screen) { return path.join(this.directory,'images',path.basename(screen.imageUrl)); }
  reference(screen) { return {imagePath:this.imagePath(screen),imageSha256:screen.imageSha256,sessionId:screen.sessionId,width:screen.width,height:screen.height,coordinateTransform:clone(screen.coordinateTransform)}; }
  async addControl(id,input) {
    const game=this._game(id), screen=this.assertCurrent(id,input), mode=input.mode;
    if(game.finished) throw new ClassifierError('Esta captura ya está finalizada',409);
    if(!Object.hasOwn(MODES,mode)) throw new ClassifierError('Modo inválido');
    const description=MODES[mode], label=input.label?.trim()||description.label;
    if(!Number.isFinite(input.x)||!Number.isFinite(input.y)||input.x<0||input.x>=1||input.y<0||input.y>=1) throw new ClassifierError('Coordenadas fuera de la imagen');
    // Preserve the upstream point validation, while our versioned schema retains roles/routes.
    normalizeDecisions({marks:[{x:input.x,y:input.y,kind:description.kind,label}]},[]);
    if(mode==='antebet' && !game.controls.some(c=>c.id===game.spinControlId && c.role==='spin' && c.sessionId===screen.sessionId))
      throw new ClassifierError('Primero marcá Spin normal (1) en esta sesión');
    if(mode==='spin_only' && game.controls.some(c=>['antebet','menu','buy','option','confirm'].includes(c.mode)))
      throw new ClassifierError('Solo Spin contradice las compras o Antebet ya marcados; conservamos esas marcas',409);
    const control={id:randomUUID(),gameId:id,screenId:screen.id,sessionId:screen.sessionId,mode,role:description.role,label,
      x:Number(input.x.toFixed(6)),y:Number(input.y.toFixed(6)),createdAt:now(),executed:false,
      ...(mode==='antebet'?{spinControlId:game.spinControlId}:{})};
    game.controls.push(control);
    if(mode==='spin'||mode==='spin_only') game.spinControlId=control.id;
    if(mode==='spin_only') { game.finished=true; game.status='classified'; game.finishedAt=now(); }
    await this.save(); return clone(control);
  }
  async finish(id,reference) {
    this.assertCurrent(id,reference); const game=this._game(id);
    game.finished=true; game.status='classified'; game.finishedAt=now();
    await this.save(); return this.game(id);
  }
  async removeControl(id,controlId,reference) {
    this.assertCurrent(id,reference); const game=this._game(id), control=game.controls.find(c=>c.id===controlId);
    if(!control) throw new ClassifierError('Marca no encontrada',404);
    if(control.executed||game.actions.some(a=>a.controlId===controlId)||game.controls.some(c=>c.spinControlId===controlId)||game.screens.some(s=>s.route.includes(controlId)))
      throw new ClassifierError('La marca tiene una acción o ruta vinculada y no se puede borrar',409);
    if(game.finished) throw new ClassifierError('La captura ya está finalizada',409);
    game.controls=game.controls.filter(c=>c.id!==controlId);
    if(game.spinControlId===controlId) game.spinControlId=null;
    await this.save(); return this.game(id);
  }
  async addAction(id,input) {
    const game=this._game(id);
    if(!game.controls.some(c=>c.id===input.controlId)) throw new ClassifierError('Acción sin control del juego');
    const action={id:randomUUID(),createdAt:now(),...sanitizeEvidence(input)};
    game.actions.push(action); await this.save(); return clone(action);
  }
  async updateAction(id,actionId,patch) {
    const game=this._game(id), action=game.actions.find(a=>a.id===actionId);
    if(!action) throw new ClassifierError('Acción no encontrada',404);
    Object.assign(action,sanitizeEvidence(patch),{updatedAt:now()});
    if(action.inputDispatched) game.controls.find(c=>c.id===action.controlId).executed=true;
    await this.save(); return clone(action);
  }
  async beginRequest(id,input) {
    this._game(id);
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId)) throw new ClassifierError('requestId inválido');
    const fingerprint=hash(canonical({gameId:id,input})), old=this.data.requests[input.requestId];
    if(old) {
      if(old.fingerprint!==fingerprint) throw new ClassifierError('requestId reutilizado con otros datos',409);
      return {duplicate:true,...clone(old)};
    }
    const request={gameId:id,fingerprint,status:'pending',createdAt:now()};
    this.data.requests[input.requestId]=request; await this.save(); return {duplicate:false,...clone(request)};
  }
  async endRequest(requestId,result) {
    const request=this.data.requests[requestId];
    if(!request) throw new ClassifierError('requestId desconocido');
    Object.assign(request,sanitizeEvidence(result),{updatedAt:now()}); await this.save();
  }
  export() {
    const games=clone(this.data.games), routes=[];
    for(const game of games) for(const control of game.controls) {
      const screen=game.screens.find(s=>s.id===control.screenId);
      const controlIds=[...(screen?.route||[]),control.id,...(control.mode==='antebet'?[control.spinControlId]:[])];
      const unresolved=game.actions.filter(action=>controlIds.includes(action.controlId) &&
        (action.status==='intent'||action.status==='uncertain'||action.uncertainDispatch||action.inputDispatched===null||
          (action.inputDispatched===true&&!action.toScreenId)));
      const needsReview=screen?.routeVerified===false||unresolved.length>0;
      routes.push({id:`route-${control.id}`,gameId:game.id,kind:control.mode,controlId:control.id,
        sourceScreenId:control.screenId,sessionId:control.sessionId,
        status:needsReview?'needs_review':control.executed?'attempted':'pending',
        replayAllowed:!needsReview,...(unresolved.length?{unresolvedActionIds:unresolved.map(action=>action.id)}:{}),
        steps:controlIds.map(controlId=>{
          const c=game.controls.find(value=>value.id===controlId), s=game.screens.find(value=>value.id===c?.screenId);
          return {controlId,role:c?.role,x:c?.x,y:c?.y,screenId:c?.screenId,revision:s?.revision,imageSha256:s?.imageSha256,coordinateTransform:s?.coordinateTransform||null,
            requiresFreshValidation:true,...(['buy','confirm','antebet','spin'].includes(c?.role)?{neverReplayAfterUncertainResult:true}:{})};
        })});
    }
    return {schemaVersion:1,runId:this.data.runId,revision:this.data.revision,exportedAt:now(),games,routes,
      exploration:{order:'breadth-first',roles:Object.keys(MODES),unseenScreens:'needs_review',coverage:'marked-routes',automaticCompletion:false}};
  }
}
