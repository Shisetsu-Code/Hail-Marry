import { probeFrame, projectThroughFrame } from './page-probe.mjs';

const OBSERVABLE_INPUT = new Set(['dom-hit-test']);
const DEFAULTS = Object.freeze({ sampleGapMs: 300, scanTimeoutMs: 5_000, maxFrames: 24,
  maxControls: 250, maxNodes: 4_000, maxDepth: 32, frameBudgetMs: 100, boundsTolerancePx: 3 });

function equalBounds(a, b, tolerance) {
  if (a === null && b === null) return true;
  return a && b && ['x', 'y', 'width', 'height'].every((key) =>
    Number.isFinite(a[key]) && Number.isFinite(b[key]) && Math.abs(a[key] - b[key]) <= tolerance);
}

function stateChanged(a, b) {
  return ['visible', 'enabled', 'interactable'].some((key) => a[key] !== b[key]) ||
    a.evidence?.receivesInput !== b.evidence?.receivesInput;
}

/** Two snapshots prove only sampled persistence; an action's effect is never inferred here. */
export function reconcileSamples(first, second, { boundsTolerancePx = 3 } = {}) {
  const previous = new Map(first.controls.map((control) => [control.id, control]));
  const current = new Set(second.controls.map((control) => control.id));
  const transient = [];
  const controls = second.controls.map((after) => {
    const before = previous.get(after.id);
    const gapMs = before ? Date.parse(after.observedAt) - Date.parse(before.observedAt) : NaN;
    const timingValid = Number.isFinite(gapMs) && gapMs >= 200 && gapMs <= 400;
    const sameIdentity = before && before.source === after.source && before.label === after.label && before.role === after.role &&
      before.frameUrl === after.frameUrl && before.documentEpoch === after.documentEpoch;
    const sameState = before && !stateChanged(before, after);
    const sameBounds = before && equalBounds(before.bounds, after.bounds, boundsTolerancePx);
    const stable = Boolean(before && sameIdentity && sameState && sameBounds && timingValid);
    const observedInput = (value) => value?.visible === true && value?.enabled === true &&
      value?.interactable === true && value?.geometryReliable === true &&
      value?.bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value.bounds[key])) &&
      value.bounds.width > 0 && value.bounds.height > 0 &&
      value?.evidence?.receivesInput === true && OBSERVABLE_INPUT.has(value?.evidence?.kind);
    const blocked = [after.visible, after.enabled, after.interactable].includes(false);
    const availability = blocked ? 'unavailable' : stable && observedInput(before) && observedInput(after) ? 'available' : 'unknown';
    let reason = !before ? 'single-sample' : !sameIdentity ? 'identity-changed' : !sameState ? 'state-changed' :
      !sameBounds ? 'bounds-changed' : !timingValid ? 'sampling-gap-outside-window' : 'two-sample-match';
    if (!before) transient.push({ id: after.id, reason: 'appeared', before: null, after });
    else if (!sameIdentity || !sameState || !sameBounds) transient.push({ id: after.id, reason, before, after });
    return { ...after, stable, availability, actionConfirmed: false,
      persistence: { samples: before ? 2 : 1, gapMs: Number.isFinite(gapMs) ? gapMs : null,
        firstObservedAt: before?.observedAt ?? null, lastObservedAt: after.observedAt ?? null, reason } };
  });
  for (const before of first.controls) {
    if (!current.has(before.id)) transient.push({ id: before.id, reason: 'disappeared', before, after: null });
  }
  return { controls, transient };
}

function abortError(signal) {
  const error = new Error(signal?.reason instanceof Error ? signal.reason.message : 'Observation aborted');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal) { if (signal?.aborted) throw abortError(signal); }

function waitUntil(time, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, time - Date.now()));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// A rejected or aborted evaluation is still observed when it eventually settles. Browser JS
// already executing cannot be forcibly interrupted by a Playwright AbortSignal.
function bounded(operation, deadline, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    const timer = setTimeout(() => {
      cleanup();
      const error = new Error('Read-only scan deadline exceeded');
      error.name = 'ScanTimeoutError';
      reject(error);
    }, Math.max(0, deadline - Date.now()));
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      checkAbort(signal);
      if (Date.now() >= deadline) {
        const error = new Error('Read-only scan deadline exceeded'); error.name = 'ScanTimeoutError'; throw error;
      }
      return operation();
    }).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

/** Read-only, bounded DOM/scene scan of every reachable frame. No click, hover, focus or dispatch. */
export class ControlStateDetector {
  #frameIds = new WeakMap();
  #nextFrameId = 1;
  #busy = false;

  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    if (!Number.isFinite(this.options.sampleGapMs) || this.options.sampleGapMs < 200 || this.options.sampleGapMs > 400) {
      throw new RangeError('sampleGapMs must be between 200 and 400 milliseconds');
    }
    for (const key of ['scanTimeoutMs', 'maxFrames', 'maxControls', 'maxNodes', 'maxDepth', 'frameBudgetMs']) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) throw new RangeError(`${key} must be a positive integer`);
    }
    if (!Number.isFinite(this.options.boundsTolerancePx) || this.options.boundsTolerancePx < 0) throw new RangeError('boundsTolerancePx must be nonnegative');
  }

  #frameId(frame) {
    if (!this.#frameIds.has(frame)) this.#frameIds.set(frame, `frame-${this.#nextFrameId++}`);
    return this.#frameIds.get(frame);
  }

  async observe(page, { signal } = {}) {
    checkAbort(signal);
    if (this.#busy) throw new Error('This detector already has an observation in progress');
    this.#busy = true;
    try {
      const first = await this.#sample(page, signal);
      await waitUntil(first.startedAtMs + this.options.sampleGapMs, signal);
      const second = await this.#sample(page, signal);
      const result = reconcileSamples(first, second, this.options);
      return { ...result, observedAt: second.observedAt, viewport: second.viewport,
        coverage: { complete: first.coverage.complete && second.coverage.complete,
          samples: [first.coverage, second.coverage], limitations: [
            'Two samples establish sampled persistence only; changes between samples may be missed.',
            'Input receipt is separate from action success; the detector performs no actions.',
            'Closed shadow roots, inaccessible frames, hidden runtime roots and unsupported transforms reduce coverage.',
            'Private engine flags and unverified scene geometry never establish availability.',
          ] },
        samples: [first, second].map((sample) => ({ observedAt: sample.observedAt,
          startedAt: new Date(sample.startedAtMs).toISOString(), durationMs: sample.durationMs, controls: sample.controls.length })) };
    } finally { this.#busy = false; }
  }

  async #sample(page, signal) {
    const startedAtMs = Date.now();
    const deadline = startedAtMs + this.options.scanTimeoutMs;
    const frames = page.frames();
    const coverage = { complete: true, framesSeen: frames.length, framesScanned: 0, frames: [], errors: [] };
    const controls = [];
    let viewport = null;
    if (frames.length > this.options.maxFrames) { coverage.complete = false; coverage.errors.push('frame-limit'); }
    for (const [frameIndex, frame] of frames.slice(0, this.options.maxFrames).entries()) {
      checkAbort(signal);
      if (Date.now() >= deadline || controls.length >= this.options.maxControls) {
        coverage.complete = false; coverage.errors.push(Date.now() >= deadline ? 'scan-deadline' : 'control-limit'); break;
      }
      const frameId = this.#frameId(frame);
      try {
        const scan = await bounded(() => frame.evaluate(probeFrame, {
          maxControls: this.options.maxControls - controls.length, maxNodes: this.options.maxNodes,
          maxDepth: this.options.maxDepth, budgetMs: this.options.frameBudgetMs,
        }), deadline, signal);
        if (frame === page.mainFrame()) viewport = scan.viewport;
        let projected = scan.controls;
        let child = frame;
        let localViewport = scan.viewport;
        let depth = 0;
        while (child.parentFrame()) {
          if (++depth > this.options.maxDepth) throw new Error('frame-depth-limit');
          const handle = await bounded(() => child.frameElement(), deadline, signal);
          try {
            const mapping = await bounded(() => handle.evaluate(projectThroughFrame, { controls: projected, viewport: localViewport }), deadline, signal);
            projected = mapping.controls;
            localViewport = mapping.viewport;
          } finally {
            await bounded(() => handle.dispose(), Date.now() + 100, undefined).catch(() => {});
          }
          child = child.parentFrame();
        }
        viewport ??= localViewport;
        for (const control of projected) {
          const bounds = control.bounds;
          const normalizedBounds = control.geometryReliable && bounds && localViewport.width > 0 && localViewport.height > 0 ? {
            x: bounds.x / localViewport.width, y: bounds.y / localViewport.height,
            width: bounds.width / localViewport.width, height: bounds.height / localViewport.height,
          } : null;
          controls.push({ ...control, id: `${frameId}:${control.source}:${scan.documentEpoch}:${control.localId}`, frameId, frameIndex,
            frameUrl: scan.documentUrl, documentEpoch: scan.documentEpoch, normalizedBounds,
            normalizedPoint: control.hitPoint && control.geometryReliable ? {
              x: control.hitPoint.x / localViewport.width, y: control.hitPoint.y / localViewport.height,
            } : null });
        }
        coverage.framesScanned++;
        coverage.frames.push({ frameId, frameIndex, ...scan.coverage });
        if (!scan.coverage.complete) coverage.complete = false;
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw abortError(signal);
        coverage.complete = false;
        coverage.errors.push({ frameId, frameIndex, error: String(error.message || error).slice(0, 300) });
        if (error.name === 'ScanTimeoutError') break;
      }
    }
    return { controls, viewport, coverage, startedAtMs, observedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs };
  }
}
