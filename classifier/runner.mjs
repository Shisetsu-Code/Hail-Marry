import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { devices } from 'playwright';
import { ControlStateDetector } from '../src/detector.mjs';
import { projectThroughFrame } from '../src/page-probe.mjs';
import { demoMode } from '../src/navigation-policy.mjs';
import { demoLaunchUrl } from '../src/launcher.mjs';
import { matchReviewedImage } from '../upstream/hybrid-cloud-fuzzer/local/visual-match.js';

const MODES = new Set(['spin', 'antebet', 'menu', 'buy', 'continue', 'option', 'confirm', 'cancel', 'back', 'bet']);
const digest = image => createHash('sha256').update(image).digest('hex');
const contains = (bounds, point) => bounds && point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
const jpeg = image => image.length >= 4 && image[0] === 255 && image[1] === 216 && image.at(-2) === 255 && image.at(-1) === 217;

/** One explicitly reviewed input per call. Composite operations belong to the graph/store. */
export class BrowserRunner {
  #browser; #targets; #sessions = new Map(); #queues = new Map(); #closed = false;
  constructor({ browser, targets, initialWaitMs = 60000, settleMs = 1500, localFixture = false } = {}) {
    if (!browser?.newContext) throw new Error('BrowserRunner requires a Playwright browser');
    if (!Number.isFinite(initialWaitMs) || initialWaitMs < 0 || (!localFixture && initialWaitMs < 60000)) throw new Error('Demo initial wait must be at least 60000 ms');
    if (!Number.isFinite(settleMs) || settleMs < 0 || (!localFixture && settleMs < 1000)) throw new Error('Invalid settle wait');
    this.#browser = browser;
    this.#targets = targets instanceof Map ? new Map(targets) : new Map(Array.isArray(targets) ? targets.map(target => [target.id, target]) : Object.entries(targets || {}));
    this.initialWaitMs = initialWaitMs; this.settleMs = settleMs; this.localFixture = localFixture;
  }
  #serial(gameId, operation) {
    if (this.#closed) return Promise.reject(new Error('Browser runner closed'));
    const previous = this.#queues.get(gameId) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    this.#queues.set(gameId, result);
    return result.finally(() => { if (this.#queues.get(gameId) === result) this.#queues.delete(gameId); });
  }
  #session(gameId) {
    const session = this.#sessions.get(gameId);
    if (!session) throw new Error('Game session is not open');
    return session;
  }
  open(gameId) {
    return this.#serial(gameId, async () => {
      if (this.#sessions.has(gameId)) return this.#observe(this.#sessions.get(gameId));
      const target = this.#targets.get(gameId);
      if (!target) throw new Error('Unknown game target');
      const url = demoLaunchUrl(target), parsed = new URL(url);
      if (parsed.username || parsed.password || !demoMode(url, { localFixture: this.localFixture })) throw new Error('Only authorized demo targets may open');
      if (target.device && !devices[target.device]) throw new Error('Unknown provider device profile');
      const profile = target.device ? devices[target.device] : {};
      const context = await this.#browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, ...profile, ...target.deviceConfig });
      try {
        const page = await context.newPage();
        // A reviewed demo launch cannot navigate the main document to a different origin.
        await page.route('**/*', async route => {
          const request = route.request();
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            const next = new URL(request.url());
            if (next.origin !== parsed.origin || next.username || next.password) return route.abort('blockedbyclient');
          }
          return route.continue();
        });
        const session = { context, page, sessionId: randomUUID(), gameId, origin: parsed.origin, detector: new ControlStateDetector(), references: new Map(), epoch: 0, lastAction: null };
        this.#sessions.set(gameId, session);
        const started = Date.now();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await delay(Math.max(0, this.initialWaitMs - (Date.now() - started)));
        return await this.#observe(session);
      } catch (error) { this.#sessions.delete(gameId); await context.close(); throw error; }
    });
  }
  observe(gameId) { return this.#serial(gameId, () => this.#observe(this.#session(gameId))); }
  async #observe(session) {
    if (new URL(session.page.url()).origin !== session.origin) throw new Error('Demo origin changed');
    const state = await session.detector.observe(session.page);
    const viewport = session.page.viewportSize();
    const image = await session.page.screenshot({ type: 'jpeg', quality: 85, fullPage: false, scale: 'css', timeout: 15000 });
    const observation = { image, imageSha256: digest(image), width: viewport.width, height: viewport.height, sessionId: session.sessionId, at: new Date().toISOString(), candidates: [], state };
    observation.candidates = state.controls.filter(c => c.visible && c.bounds && c.geometryReliable).map(c => {
      const p = c.hitPoint || { x: c.bounds.x + c.bounds.width / 2, y: c.bounds.y + c.bounds.height / 2 };
      return { id: c.id, label: c.label, source: c.source, role: c.role, availability: c.availability, x: p.x / viewport.width, y: p.y / viewport.height,
        bounds: { x: c.bounds.x / viewport.width, y: c.bounds.y / viewport.height, width: c.bounds.width / viewport.width, height: c.bounds.height / viewport.height } };
    }).filter(c => c.x >= 0 && c.x < 1 && c.y >= 0 && c.y < 1);
    session.references.set(observation.imageSha256, { width: observation.width, height: observation.height, state, epoch: session.epoch });
    return observation;
  }
  async #domCheck(session, expected, fresh, point) {
    const previous = expected.state.controls.filter(c => c.source === 'dom' && c.visible && contains(c.bounds, point)).sort((a,b) => a.bounds.width*a.bounds.height-b.bounds.width*b.bounds.height)[0];
    if (!previous) return { status: 'unavailable', reason: 'No DOM target at the reviewed point; visual verification only' };
    const current = fresh.state.controls.find(c => c.id === previous.id);
    if (!current || current.documentEpoch !== previous.documentEpoch || current.frameUrl !== previous.frameUrl || current.label !== previous.label || !contains(current.bounds, point)) throw new Error('DOM hit target changed before input');
    if (current.availability !== 'available' || !current.enabled) throw new Error('DOM target disabled, covered, or unavailable');
    const frame = session.page.frames()[current.frameIndex];
    if (!frame || frame.url() !== current.frameUrl || !current.selector) throw new Error('DOM hit target cannot be revalidated');
    const relative = { x: (point.x-current.bounds.x)/current.bounds.width, y: (point.y-current.bounds.y)/current.bounds.height };
    const hit = await frame.locator(current.selector).evaluate((element, relative) => {
      const bounds = element.getBoundingClientRect();
      let hit = element.ownerDocument.elementFromPoint(bounds.x + relative.x*bounds.width, bounds.y + relative.y*bounds.height);
      for (let i = 0; hit?.shadowRoot && i < 32; i++) { const next=hit.shadowRoot.elementFromPoint(bounds.x + relative.x*bounds.width,bounds.y + relative.y*bounds.height); if (!next || next === hit) break; hit=next; }
      let receives = false;
      for (let node = hit, i = 0; node && i < 64; i++, node = node.parentElement || node.getRootNode()?.host) if (node === element) { receives = !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]'); break; }
      return { receives, point: { x: bounds.x + relative.x*bounds.width, y: bounds.y + relative.y*bounds.height }, viewport: { width: innerWidth, height: innerHeight } };
    }, relative, { timeout: 3000 });
    if (!hit.receives) throw new Error('Reviewed DOM point is covered or no longer receives input');
    let child = frame, projectedPoint = hit.point, localViewport = hit.viewport;
    while (child.parentFrame()) {
      const handle = await child.frameElement();
      try {
        const mapping = await handle.evaluate(projectThroughFrame, { viewport: localViewport, controls: [{
          bounds: { ...projectedPoint, width: 1, height: 1 }, probePoints: [projectedPoint], inputPoints: [projectedPoint],
          visible: true, enabled: true, geometryReliable: true, interactable: true, evidence: { receivesInput: true },
        }] });
        const projected = mapping.controls[0];
        if (!projected.geometryReliable || !projected.evidence.receivesInput) throw new Error('Reviewed DOM point is covered in a parent frame');
        projectedPoint = projected.inputPoints[0]; localViewport = mapping.viewport;
      } finally { await handle.dispose(); }
      child = child.parentFrame();
    }
    return { status: 'matched', reason: 'Fresh DOM hit test receives pointer input', id: current.id };
  }
  async #targetMatch(page, reference, current, point) {
    // Reuse the upstream comparison on detached target crops, omitting only scene distance.
    const crops = await page.evaluate(async ({ before, after, point }) => {
      const crop = async encoded => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/jpeg' }));
        try { const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 144;
          const x = Math.max(0,Math.min(.84,point.x-.08)), y = Math.max(0,Math.min(.84,point.y-.08));
          canvas.getContext('2d').drawImage(bitmap,x*bitmap.width,y*bitmap.height,.16*bitmap.width,.16*bitmap.height,0,0,256,144);
          return canvas.toDataURL('image/jpeg',.95).split(',')[1];
        } finally { bitmap.close(); }
      };
      return Promise.all([crop(before),crop(after)]);
    }, { before: reference.toString('base64'), after: current.toString('base64'), point });
    return matchReviewedImage(page, Buffer.from(crops[0], 'base64'), Buffer.from(crops[1], 'base64'), { x: .5, y: .5 });
  }
  perform(gameId, { control, reference, scope = 'scene' } = {}) {
    let dispatchAttempted = false;
    return this.#serial(gameId, async () => {
      const session = this.#session(gameId);
      if (!control || control.gameId !== gameId) throw new Error('Control belongs to another game');
      if (control.sessionId !== session.sessionId || reference?.sessionId !== session.sessionId) throw new Error('Stale or mismatched browser session');
      if (!MODES.has(control.mode)) throw new Error('Unsupported input mode; spin_only is mark-only');
      if (!Number.isFinite(control.x) || !Number.isFinite(control.y) || control.x < 0 || control.x >= 1 || control.y < 0 || control.y >= 1) throw new Error('Invalid normalized point');
      if (!['scene', 'target'].includes(scope)) throw new Error('Unknown visual verification scope');
      const viewport = session.page.viewportSize();
      if (reference.width !== viewport.width || reference.height !== viewport.height) throw new Error('Reference viewport changed');
      if (typeof reference.imagePath !== 'string') throw new Error('Immutable reference imagePath required');
      const image = await readFile(reference.imagePath), hash = digest(image);
      if (reference.imageSha256 && reference.imageSha256 !== hash) throw new Error('Reference image hash mismatch');
      if (!jpeg(image) || image.length > 8*1024*1024) throw new Error('Invalid reference JPEG');
      const expected = session.references.get(hash);
      if (!expected) throw new Error('Reference image was not observed in this game session');
      if (expected.width !== viewport.width || expected.height !== viewport.height) throw new Error('Observed viewport changed');
      if (scope === 'scene' && expected.epoch !== session.epoch) throw new Error('Stale reference predates a dispatched input; review the current scene');
      if (scope === 'target' && (control.mode !== 'spin' || !control.linkedAnteControlId || session.lastAction?.mode !== 'antebet' || session.lastAction.controlId !== control.linkedAnteControlId || expected.epoch > session.lastAction.sourceEpoch || session.epoch !== session.lastAction.sourceEpoch + 1)) throw new Error('Target scope requires the explicitly linked Spin immediately after its antebet');
      const before = await this.#observe(session), point = { x: control.x, y: control.y };
      const dom = await this.#domCheck(session, expected, before, { x: point.x*viewport.width, y: point.y*viewport.height });
      const visual = scope === 'scene' ? await matchReviewedImage(session.page,image,before.image,point) : await this.#targetMatch(session.page,image,before.image,point);
      if (!visual.matched) throw new Error('Reviewed screen or target changed: '+visual.reason);
      // Recheck pointer receipt after visual decoding, immediately before actual input.
      await this.#domCheck(session, expected, before, { x: point.x*viewport.width, y: point.y*viewport.height });
      const network = [], requests = new Map();
      const onRequest = request => {
        if (!['fetch','xhr','document'].includes(request.resourceType()) || network.length >= 100) return;
        const url = new URL(request.url());
        const record = { at: new Date().toISOString(), method: request.method(), url: url.origin+url.pathname, resourceType: request.resourceType(), status: null };
        network.push(record); requests.set(request, record);
      };
      const onResponse = response => { const record=requests.get(response.request()); if(record) record.status=response.status(); };
      session.page.on('request',onRequest);session.page.on('response',onResponse);
      try {
        dispatchAttempted = true;
        // A lost transport acknowledgement cannot prove whether Chromium received the click.
        // Invalidate prior references before dispatch, including the uncertain failure path.
        const sourceEpoch = session.epoch++;
        session.lastAction = null;
        try { await session.page.mouse.click(point.x*viewport.width,point.y*viewport.height); }
        catch (error) {
          return { before, after: null, inputDispatched: null, uncertainDispatch: true,
            confirmation: { status: 'pending', reason: 'Click dispatch acknowledgement unavailable; input may have occurred: '+error.message },
            network, verification: { scope, visual, dom } };
        }
        session.lastAction = { mode: control.mode, controlId: control.id, referenceHash: hash, sourceEpoch };
        await delay(this.settleMs);
        let after;
        try { after = await this.#observe(session); } catch(error) {
          return { before, after: null, inputDispatched: true, confirmation: { status: 'pending', reason: 'Input dispatched; next observation unavailable: '+error.message }, network, verification: { scope,visual,dom } };
        }
        return { before, after, inputDispatched: true, confirmation: { status: 'pending', reason: 'Input dispatched; screenshot and network metadata do not prove a completed round or purchase' }, network, verification: { scope,visual,dom } };
      } finally {session.page.off('request',onRequest);session.page.off('response',onResponse);}
    }).catch(error => { error.inputMayHaveDispatched = dispatchAttempted; throw error; });
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#queues.values()]);
    await Promise.allSettled([...this.#sessions.values()].map(session=>session.context.close()));
    this.#sessions.clear();
  }
}
