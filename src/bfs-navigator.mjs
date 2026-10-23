import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { GameSession } from './session.mjs';
import { introCandidates, sameCandidate } from './intro.mjs';
import { delay, mapConcurrent } from './timing.mjs';
import { demoLaunchUrl } from './launcher.mjs';
import { discoverActions, demoMode, matchRoute, routeAllowed, screenPacket, stateFingerprint, normalizeText } from './navigation-policy.mjs';
import { ReviewStore } from './gpt-review.mjs';

const humanError = e => String(e?.message || e).slice(0, 320);
function boundedInt(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label} must be ${min}..${max}`);
  return value;
}
function pointOkay(point, viewport) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 &&
    point.x < viewport.width && point.y < viewport.height;
}
function cleanRoute(candidate) {
  return { kind: candidate.kind, gptDriven: candidate.gptDriven === true, routeKey: candidate.routeKey, source: candidate.source, text: candidate.text,
    localPath: candidate.localPath, normalizedPoint: candidate.normalizedPoint };
}
function relevantText(state) {
  return (state.ocr?.lines || []).filter(l => l.confidence >= 65).map(l => l.text).join(' ');
}
function isSafeIntro(candidate, state, { classification } = {}) {
  const normalized = normalizeText(candidate.text);
  if (/\b(buy|purchase|confirm purchase|spin|bet|deposit|comprar|compra|apuesta|girar)\b/.test(normalized)) return false;
  if (/(click|tap|press|touch|clic|pulsa|toca|presiona).{0,30}(continue|start|begin|anywhere|continuar|empezar)/.test(normalized)) return true;
  if (!/^(continue|continuar)$/.test(normalized)) return false;
  if (classification?.screenKind === 'intro') return true;
  const available = (state.controls || []).filter(c => c.availability === 'available');
  const otherText = relevantText(state).toLowerCase();
  // Isolated CONTINUE is accepted only with no competing DOM gameplay controls.
  return available.length === 0 && !/(buy bonus|buy feature|spin|bet\s*[+\-]|confirm purchase)/.test(otherText);
}

/** Conservative input orchestration around GameSession's read-only detector. */
export class BFSInput {
  constructor(session) { this.session = session; }
  async perform(original, state, { allowEngine = true } = {}) {
    const session = this.session;
    const before = await session.observe('bfs-action-check');
    const target = matchRoute(before, original, { allowEngine });
    if (!target || !pointOkay(target.point, before.viewport)) throw new Error('BFS target changed/disappeared during revalidation');
    if (target.source === 'dom') {
      const after = await session.actOnControl(target.control);
      return { state: after, dispatched: true, changed: stateFingerprint(before) !== stateFingerprint(after), confirmed: false };
    }
    // Engine and OCR are NOT proven input-ready. Require another current double sample
    // and only dispatch to the exact stable, geometrically reliable target.
    const fresh = await session.observe('bfs-input-check');
    const verified = matchRoute(fresh, target, { allowEngine });
    if (!verified || !pointOkay(verified.point, fresh.viewport) ||
        !sameCandidate({ ...target, bounds: target.bounds, text: target.text },
          { ...verified, bounds: verified.bounds, text: verified.text }, 12)) {
      throw new Error('BFS target failed two-state verification');
    }
    if (verified.source === 'ocr') {
      // OCR of both full screenshots must agree on text and geometry; animation pixels may differ.
      if (!fresh.ocr?.lines?.some(l => normalizeText(l.text) === normalizeText(verified.text) &&
          Math.abs(l.bounds.x - verified.bounds.x) < 12 && Math.abs(l.bounds.y - verified.bounds.y) < 12 &&
          new Set(l.readings || []).size >= 2)) throw new Error('OCR prompt not stable before input');
    } else if (verified.availability === 'unavailable' || !verified.control?.stable ||
               verified.control.visible !== true || verified.control.enabled !== true ||
               verified.control.geometryReliable !== true) {
      throw new Error('Engine candidate is not stable and geometrically reliable');
    }
    const action = { kind: 'bfs:' + verified.kind, candidateId: verified.id, text: verified.text,
      source: verified.source, point: verified.point, dispatchedAt: new Date().toISOString(),
      inputDispatched: false, actionConfirmed: false, inputAvailability: verified.availability };
    session.report.actions.push(action);
    await session.page.mouse.click(verified.point.x, verified.point.y, { timeout: 3000 });
    action.inputDispatched = true;
    session.event('bfs-input-dispatched', { kind: verified.kind, source: verified.source, candidateId: verified.id });
    const settled = Date.now();
    await delay(session.settleMs, session.signal);
    action.settleElapsedMs = Date.now() - settled;
    const after = await session.observe('bfs-after-action');
    action.observationIndex = after.index;
    action.stateChanged = stateFingerprint(before) !== stateFingerprint(after);
    await session.save();
    return { state: after, dispatched: true, changed: action.stateChanged, confirmed: false };
  }
}

/** BFS by shortest menu path; replay starts in isolated fresh demo contexts. */
export class BFSNavigator {
  constructor({ browser, target, outputDir, reviewStore, laya = null, initialWaitMs = 60000, settleMs = 1500,
    maxDepth = 3, maxNodes = 20, maxPerNode = 8, concurrency = 2, nodeDeadlineMs = 210000,
    initiateDemoPurchase = false, localFixture = false, onEvent = () => {} } = {}) {
    if (!browser || !target?.url || !outputDir) throw new Error('BFSNavigator requires browser, demo target and outputDir');
    this.browser = browser; this.target = target; this.outputDir = outputDir; this.review = reviewStore || new ReviewStore(path.join(outputDir, 'review'));
    this.laya = laya; this.initialWaitMs = initialWaitMs; this.settleMs = settleMs;
    this.maxDepth = boundedInt(maxDepth, 0, 8, 'maxDepth'); this.maxNodes = boundedInt(maxNodes, 1, 100, 'maxNodes');
    this.maxPerNode = boundedInt(maxPerNode, 1, 30, 'maxPerNode'); this.concurrency = boundedInt(concurrency, 1, 8, 'concurrency');
    this.nodeDeadlineMs = boundedInt(nodeDeadlineMs, 10000, 1200000, 'nodeDeadlineMs');
    this.demo = demoMode(demoLaunchUrl(target), { localFixture });
    this.initiateDemoPurchase = initiateDemoPurchase;
    this.onEvent = onEvent;
    this.graph = { schemaVersion: 1, game: target.id, demo: this.demo, startedAt: new Date().toISOString(),
      settings: { initialWaitMs, settleMs, maxDepth, maxNodes, maxPerNode, concurrency, initiateDemoPurchase },
      nodes: [], edges: [], errors: [], metrics: {} };
    this.seenState = new Map();
  }
  event(type, data = {}) { this.onEvent({ at: new Date().toISOString(), type, ...data }); }
  async #queueState(state, pathEdges) {
    const preliminary = discoverActions(state);
    const packet = screenPacket(state, preliminary, pathEdges);
    let classification = null;
    try { classification = await this.review.record(packet); }
    catch(e) { this.graph.errors.push({ phase: 'gpt-review', message: humanError(e) }); }
    return { classification, packet, actions: discoverActions(state, { gptKinds: classification?.kinds || {} }) };
  }
  async #continueIntro(session, initial, routePath) {
    let state = initial;
    for (let i=0; i<3; i++) {
      const candidates = introCandidates(state);
      if (!candidates.length) break;
      const { classification } = await this.#queueState(state, routePath);
      const eligible = candidates.filter(c => isSafeIntro(c, state, { classification }));
      if (eligible.length !== 1) {
        this.event('bfs-intro-pending', { reason:'no-single-safe-target', text:candidates.map(c=>c.text) });
        break;
      }
      const initial = eligible[0];
      const fresh = await session.observe('bfs-intro-check');
      const candidate = introCandidates(fresh).find(c => sameCandidate(initial, c));
      if (!candidate) { this.event('bfs-intro-pending', { reason:'target-changed' }); break; }
      // GameSession uses a strict animated-pixel equality gate for OCR. BFS instead
      // verifies text + coordinates again, so harmless animation does not block intro.
      const current = discoverActions(fresh).find(c => c.id === candidate.id && c.kind === 'intro_continue');
      if (!current) { this.event('bfs-intro-pending', { reason:'ocr-recheck-failed' }); break; }
      const input = new BFSInput(session);
      const result = await input.perform(current, fresh);
      state = result.state;
      if (introCandidates(state).some(c => sameCandidate(c, candidate))) {
        this.event('bfs-intro-pending', { reason:'prompt-unchanged' }); break;
      }
    }
    return state;
  }
  async #visit(task, index) {
    const browserContext = await this.browser.newContext(this.target.deviceConfig || { viewport: {width:1280,height:720}, deviceScaleFactor:1 });
    const page = await browserContext.newPage();
    const id = `node-${String(index).padStart(3,'0')}`;
    const sessionDir = path.join(this.outputDir, id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('BFS node deadline exceeded')), this.nodeDeadlineMs);
    const session = new GameSession(page, { outputDir: sessionDir, laya: this.laya, initialWaitMs: this.initialWaitMs,
      settleMs: this.settleMs, signal: controller.signal,
      onEvent: ev => this.event('session-' + ev.type, { nodeId: id, ...ev }) });
    let state;
    try {
      state = await session.open(demoLaunchUrl(this.target));
      state = await this.#continueIntro(session, state, task.path);
      for (let depth=0;depth<task.path.length;depth++) {
        const route = task.path[depth];
        const current = matchRoute(state, route);
        if (!current || !routeAllowed(current, { demo: this.demo, initiateDemoPurchase: this.initiateDemoPurchase, ancestry: task.path.slice(0, depth) })) {
          throw new Error(`Cannot deterministically replay route ${depth}: ${route.kind} ${route.text}`);
        }
        const transition = await new BFSInput(session).perform(current, state);
        state = transition.state;
        if (!transition.changed) {
          this.event('bfs-action-no-visible-change', { nodeId:id, kind: route.kind, label: route.text });
          return {id, status:'no_observable_change', path:task.path, fingerprint:stateFingerprint(state), screenshot:state.screenshot, actionsDispatched:session.report.actions.filter(a=>a.inputDispatched).length};
        }
        state = await this.#continueIntro(session, state, task.path.slice(0,depth+1));
      }
      const fingerprint = stateFingerprint(state);
      const { packet, classification, actions } = await this.#queueState(state, task.path);
      const available = actions.filter(candidate => routeAllowed(candidate, { demo: this.demo,
        initiateDemoPurchase: this.initiateDemoPurchase, ancestry: task.path }));
      return { id, status: 'observed', fingerprint, packet, classification,
        state: { screenshot: path.join(id,state.screenshot), ocrText:packet.text.slice(0,1500), controls: state.controls.length,
          stable: state.controls.filter(c => c.stable).length, coverageComplete: state.coverage?.complete === true },
        eligible: available, otherCandidates: actions.filter(c => !available.includes(c)).slice(0,24).map(cleanRoute),
        path: task.path, actionsDispatched: session.report.actions.filter(a => a.inputDispatched).length };
    } catch (error) {
      return { id, status:'failed', path:task.path, error:humanError(error), screenshot:state?.screenshot || null };
    } finally {
      clearTimeout(timer);
      await session.save().catch(()=>{});
      await browserContext.close().catch(()=>{});
    }
  }
  async run() {
    await mkdir(this.outputDir,{recursive:true});
    if (!this.demo) { this.graph.errors.push({phase:'guard',message:'BFS requires a verified FUN/DEMO/practice URL'}); await this.save(); return this.graph; }
    let frontier=[{path:[]}], visitedPaths=new Set(['root']), expanded=0, exploredEdges=0;
    for (let depth=0; depth<=this.maxDepth && frontier.length && expanded < this.maxNodes; depth++) {
      const wave=frontier.slice(0, this.maxNodes - expanded);
      this.event('bfs-wave', { depth, nodes:wave.length });
      const results = await mapConcurrent(wave,this.concurrency,(task,i)=>this.#visit(task,expanded+i));
      const next=[];
      for(let index=0;index<results.length;index++) {
        const outcome=results[index].status==='fulfilled' ? results[index].value : { id:`node-${expanded+index}`, status:'failed',error:results[index].reason,path:wave[index].path };
        const pathEdges=outcome.path || [];
        const parent=pathEdges.length>0 ? pathEdges.slice(0,-1).map(e=>e.routeKey).join('>') || 'root' : null;
        const pathKey=pathEdges.map(e=>e.routeKey).join('>') || 'root';
        const rawNode={ id:outcome.id, path: pathEdges, pathKey, parentPathKey:parent, via:pathEdges.at(-1) || null,
          status:outcome.status, fingerprint:outcome.fingerprint || null,
          screenshot:outcome.state?.screenshot || outcome.screenshot || null,
          ocrText:outcome.state?.ocrText || '', controls:outcome.state?.controls || 0,
          coverageComplete:outcome.state?.coverageComplete || false, error:outcome.error || null,
          eligible:outcome.eligible?.map(cleanRoute) || [], blocked:outcome.otherCandidates || [],
          actionsDispatched:outcome.actionsDispatched || 0 };
        if (outcome.status==='observed') {
          if (this.seenState.has(outcome.fingerprint)) {
            rawNode.status='duplicate_state';
            rawNode.sameAs=this.seenState.get(outcome.fingerprint);
          } else this.seenState.set(outcome.fingerprint,outcome.id);
        }
        this.graph.nodes.push(rawNode);
        if (parent) {
          this.graph.edges.push({ from: parent, to: pathKey, via: rawNode.via,
            result:rawNode.status, changed: rawNode.status==='observed' || rawNode.status==='duplicate_state' });
          exploredEdges++;
        }
        if (rawNode.status!=='observed' || depth === this.maxDepth) continue;
        for(const candidate of (outcome.eligible || []).slice(0,this.maxPerNode)) {
          const edge=cleanRoute(candidate);
          const childPath=[...pathEdges,edge];
          const key=childPath.map(e=>e.routeKey).join('>');
          if (visitedPaths.has(key)) continue;
          visitedPaths.add(key);
          next.push({path:childPath});
        }
      }
      expanded+=wave.length;
      frontier=next;
      await this.save();
    }
    const all = this.graph.nodes;
    const counted = all.filter(x=>x.status==='observed');
    this.graph.metrics = {
      visited:all.length, dispatchedInputs:all.reduce((sum,n)=>sum+n.actionsDispatched,0), uniqueStates:this.seenState.size, duplicates:all.filter(x=>x.status==='duplicate_state').length,
      failed:all.filter(x=>x.status==='failed').length, edgesAttempted:exploredEdges,
      discoveredBonusEntries:counted.reduce((a,n)=>a+n.eligible.filter(x=>x.kind==='bonus_entry').length,0),
      discoveredBonusOptions:counted.reduce((a,n)=>a+n.eligible.filter(x=>x.kind==='bonus_option').length,0),
      discoveredBetControls:counted.reduce((a,n)=>a+n.eligible.filter(x=>x.kind==='bet_adjust').length,0),
      discoveredAnteControls:counted.reduce((a,n)=>a+n.eligible.filter(x=>x.kind==='ante_toggle').length,0),
      demoPurchaseOptionsVisited:all.filter(n=>['observed','duplicate_state'].includes(n.status) && n.via?.kind==='bonus_option').length,
      purchaseConfirmationsBlocked:counted.reduce((a,n)=>a+n.blocked.filter(x=>x.kind==='purchase_confirm').length,0),
      pendingFrontier:frontier.length, truncated:frontier.length>0 || expanded>=this.maxNodes,
      // Action dispatch and effect evidence are kept separate in each node report.
    };
    this.graph.finishedAt=new Date().toISOString();
    await this.save();
    return this.graph;
  }
  async save() {
    await mkdir(this.outputDir,{recursive:true});
    await this.review.save();
    await writeFile(path.join(this.outputDir,'bfs-graph.json'),JSON.stringify(this.graph,null,2)+'\n');
  }
}
