import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ClassifierError, sanitizeEvidence } from './store.mjs';

const sha256=value=>createHash('sha256').update(value).digest();
const json=(response,status,data)=>{
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(data));
};
async function bodyOf(request) {
  if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']||'')) throw new ClassifierError('Se requiere JSON',415);
  const chunks=[];let length=0;
  for await(const chunk of request) {
    length+=chunk.length;
    if(length>32768) throw new ClassifierError('Solicitud demasiado grande',413);
    chunks.push(chunk);
  }
  let body;
  try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new ClassifierError('JSON inválido');}
  if(!body||typeof body!=='object'||Array.isArray(body)) throw new ClassifierError('Se requiere un objeto JSON');
  return body;
}

export function createClassifierServer({store,runner,tokenHash,publicDir}={}) {
  if(!/^[a-f0-9]{64}$/.test(tokenHash||'')) throw new Error('A SHA-256 access key hash is required');
  const expected=Buffer.from(tokenHash,'hex'),locks=new Set();
  const assets=new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/styles.css','styles.css']]);
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  const authenticated=request=>{
    const value=request.headers.authorization||'';
    if(!value.startsWith('Bearer ')||value.length>1024) return false;
    return timingSafeEqual(sha256(value.slice(7)),expected);
  };
  function rememberOutcome(id,actionId,patch) {
    const game=store._game(id), action=game.actions.find(item=>item.id===actionId);
    Object.assign(action,sanitizeEvidence(patch));
    if(patch.inputDispatched===true) game.controls.find(item=>item.id===action.controlId).executed=true;
  }
  function requireReview(id,message) {
    Object.assign(store._game(id),{requiresReview:true,status:'needs_review',error:message});
  }

  async function perform(id,control,{scope='scene',linkedAnteControlId}={}) {
    const game=store.game(id), current=game.screen;
    const source=game.screens.find(screen=>screen.id===control.screenId);
    if(!source||source.sessionId!==current.sessionId) throw new ClassifierError('La marca pertenece a otra sesión. Marcá el control en la captura actual.',409);
    const action=await store.addAction(id,{controlId:control.id,fromScreenId:current.id,role:control.role,
      status:'intent',inputDispatched:false,confirmation:{status:'pending',reason:'Acción registrada antes de enviar input'},
      ...(linkedAnteControlId?{linkedAnteControlId}:{})});
    // Publish the intent before any external input, so restart never silently replays it.
    await store.checkpoint();
    let result;
    try {
      result=await runner.perform(id,{control:{...control,...(linkedAnteControlId?{linkedAnteControlId}:{})},reference:store.reference(source),scope});
    } catch(error) {
      const uncertain=error.inputMayHaveDispatched!==false;
      const patch={status:uncertain?'uncertain':'blocked',inputDispatched:uncertain?null:false,
        uncertainDispatch:uncertain,confirmation:{status:'pending',reason:String(error.message).slice(0,320)}};
      rememberOutcome(id,action.id,patch);
      if(uncertain) requireReview(id,'La conexión se interrumpió durante la acción. Actualizá antes de seguir.');
      try {await store.updateAction(id,action.id,patch);} catch {
        await store.save().catch(()=>{});
        throw new ClassifierError(uncertain?'La acción puede haberse enviado y falta guardar su evidencia. Actualizá para revisar.':'No se envió el clic; falta guardar el rechazo.',503);
      }
      throw new ClassifierError((uncertain?'La acción puede haberse enviado; actualizá para revisar. ':'No se envió el clic: ')+String(error.message).slice(0,220),409);
    }
    const uncertain=result.uncertainDispatch===true || result.inputDispatched===null;
    const patch={status:uncertain?'uncertain':result.inputDispatched?'dispatched':'blocked',
      inputDispatched:uncertain?null:result.inputDispatched===true,uncertainDispatch:uncertain,
      confirmation:result.confirmation||{status:'pending',reason:'Sin confirmación'},network:result.network||[],verification:result.verification||null};
    rememberOutcome(id,action.id,patch);
    try {
      await store.updateAction(id,action.id,patch);
      if(!result.after || uncertain) {
        await store.setGame(id,{requiresReview:true,status:'needs_review',error:'La acción necesita una captura nueva para revisar su resultado.'});
        return {id:action.id,inputDispatched:uncertain?null:result.inputDispatched===true,pending:true};
      }
      const after=await store.capture(id,result.after,{parentScreenId:current.id,viaControlId:control.id,route:[...current.route,control.id]});
      await store.updateAction(id,action.id,{toScreenId:after.id});
      return {id:action.id,inputDispatched:result.inputDispatched===true,pending:false};
    } catch(error) {
      // Input already crossed the boundary; even a local disk error must not reopen it for retry.
      requireReview(id,'Falta guardar o revisar la evidencia posterior a la acción.');
      await store.save().catch(()=>{});
      throw new ClassifierError('La acción se envió o quedó incierta; falta su evidencia. Actualizá antes de seguir.',503);
    }
  }

  async function mutate(id,operation,input,controlId) {
    if(locks.has(id)) throw new ClassifierError('Este juego está procesando una acción. Esperá la captura siguiente.',409);
    locks.add(id);
    const fingerprintInput={...input,operation,...(controlId?{controlId}:{})};
    let request,output,error;
    try {
      request=await store.beginRequest(id,fingerprintInput);
      if(request.duplicate) {
        if(request.status==='failed') throw new ClassifierError(request.error||'La solicitud anterior quedó pendiente; revisá el estado',request.httpStatus||409);
        return {status:request.status==='done'?200:202,body:{game:store.game(id),duplicate:true,pending:request.status!=='done'}};
      }
      store.assertCurrent(id,input);
      const game=store.game(id);
      if(game.finished && !['refresh','finish'].includes(operation)) throw new ClassifierError('Esta captura ya está finalizada',409);
      if(game.requiresReview && !['refresh','finish'].includes(operation)) throw new ClassifierError('Hay una acción pendiente de revisar. Actualizá la captura antes de continuar.',409);
      await store.setGame(id,{busy:true});
      if(operation==='mark') {
        const control=await store.addControl(id,input);
        output={control};
        if(input.execute!==false && !['spin','spin_only'].includes(control.mode)) {
          output.action=await perform(id,control);
          if(control.mode==='antebet' && output.action.inputDispatched && !output.action.pending) {
            const spin=store.game(id).controls.find(c=>c.id===control.spinControlId);
            output.spinAction=await perform(id,spin,{scope:'target',linkedAnteControlId:control.id});
          }
        }
      } else if(operation==='action') {
        const control=game.controls.find(c=>c.id===input.controlId);
        if(!control) throw new ClassifierError('Marca no encontrada',404);
        if(control.mode==='spin_only') throw new ClassifierError('Solo Spin finaliza la captura sin ejecutar',409);
        if(control.screenId!==game.screen.id) throw new ClassifierError('La marca es de una pantalla anterior. Volvé a marcarla en la captura actual.',409);
        output={control,action:await perform(id,control)};
        if(control.mode==='antebet'&&output.action.inputDispatched&&!output.action.pending) {
          const spin=store.game(id).controls.find(c=>c.id===control.spinControlId);
          output.spinAction=await perform(id,spin,{scope:'target',linkedAnteControlId:control.id});
        }
      } else if(operation==='refresh') {
        const current=game.screen;
        const unresolved=[...game.actions].reverse().find(a=>!a.toScreenId && a.fromScreenId===current.id && (a.inputDispatched===true||a.uncertainDispatch===true));
        const after=await store.capture(id,await runner.observe(id),{parentScreenId:current.id,
          route:unresolved?[...current.route,unresolved.controlId]:current.route,viaControlId:unresolved?.controlId||null,
          ...(unresolved?.uncertainDispatch?{uncertainTransition:{actionId:unresolved.id,controlId:unresolved.controlId}}:{})});
        if(unresolved) await store.updateAction(id,unresolved.id,{toScreenId:after.id,reconciledByObservation:true});
        await store.setGame(id,{requiresReview:false,error:null,status:game.finished?'classified':'ready'});
        output={refreshed:true};
      } else if(operation==='finish') {
        await store.finish(id,input); output={finished:true};
      } else if(operation==='delete') {
        await store.removeControl(id,controlId,input); output={removed:true};
      } else throw new ClassifierError('Operación desconocida',404);
      await store.endRequest(input.requestId,{status:'done',controlId:output.control?.id,actionId:output.action?.id});
    } catch(cause) {
      error=cause instanceof ClassifierError?cause:new ClassifierError(String(cause.message||cause).slice(0,320),cause.status||500);
      if(request&&!request.duplicate) {
        await store.endRequest(input.requestId,{status:'failed',httpStatus:error.status,error:error.message}).catch(()=>{});
      }
    } finally {
      if(request&&!request.duplicate) {
        await store.setGame(id,{busy:false}).catch(()=>{});
        try { await store.checkpoint(); } catch(cause) {error=cause;}
      }
      locks.delete(id);
    }
    if(error) throw error;
    return {status:200,body:{game:store.game(id),...output}};
  }

  const server=http.createServer(async(request,response)=>{
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url=new URL(request.url,'http://classifier.local');
      if(request.method==='GET'&&url.pathname==='/health') return json(response,200,{ok:true,service:'hail-marry-classifier',schemaVersion:1});
      if(request.method==='GET'&&assets.has(url.pathname)) {
        const file=assets.get(url.pathname), content=await readFile(path.join(publicDir,file));
        response.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-store'}); return response.end(content);
      }
      if(!url.pathname.startsWith('/api/')) throw new ClassifierError('No encontrado',404);
      if(!authenticated(request)) return json(response,401,{error:'Clave de acceso requerida'});
      if(request.method==='GET'&&url.pathname==='/api/state') return json(response,200,store.state());
      if(request.method==='GET'&&url.pathname==='/api/export') {
        response.setHeader('Content-Disposition',`attachment; filename="${store.data.runId}-routes.json"`);
        return json(response,200,store.export());
      }
      const image=url.pathname.match(/^\/api\/images\/([a-zA-Z0-9_.-]+\.jpg)$/);
      if(request.method==='GET'&&image) {
        const authorized=store.data.games.some(g=>g.screens.some(s=>s.imageUrl===url.pathname));
        if(!authorized) throw new ClassifierError('Captura no encontrada',404);
        const bytes=await readFile(path.join(store.directory,'images',image[1]));
        response.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=31536000, immutable'}); return response.end(bytes);
      }
      const game=url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_.-]+)$/);
      if(request.method==='GET'&&game) return json(response,200,{game:store.game(game[1])});
      const route=url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_.-]+)\/(mark|action|refresh|finish)$/);
      if(request.method==='POST'&&route) {
        const result=await mutate(route[1],route[2],await bodyOf(request)); return json(response,result.status,result.body);
      }
      const deletion=url.pathname.match(/^\/api\/games\/([a-zA-Z0-9_.-]+)\/controls\/([a-zA-Z0-9_-]+)$/);
      if(request.method==='DELETE'&&deletion) {
        const result=await mutate(deletion[1],'delete',await bodyOf(request),deletion[2]);return json(response,result.status,result.body);
      }
      throw new ClassifierError('No encontrado',404);
    } catch(error) {
      if(!response.headersSent) json(response,error.status||500,{error:String(error.message||'Error interno').slice(0,400)});
      else response.destroy();
    }
  });
  server.requestTimeout=60000; server.headersTimeout=15000;
  return server;
}
