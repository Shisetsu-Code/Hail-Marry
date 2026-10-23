import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ControlStateDetector } from './detector.mjs';
import { readScreenshotText } from './ocr.mjs';
import { introCandidates, sameCandidate, validateDecision } from './intro.mjs';
import { delay } from './timing.mjs';

export class GameSession {
  constructor(page, { outputDir, laya, initialWaitMs = 60000, settleMs = 1500, sampleGapMs = 300, signal, onEvent = () => {} } = {}) {
    if (!Number.isFinite(initialWaitMs) || initialWaitMs < 0) throw new Error('Invalid initial wait');
    if (!Number.isFinite(settleMs) || settleMs < 1000 || settleMs > 2000) throw new Error('settleMs must be 1000–2000');
    this.page = page;
    this.outputDir = outputDir;
    this.laya = laya;
    this.initialWaitMs = initialWaitMs;
    this.settleMs = settleMs;
    this.detector = new ControlStateDetector({ sampleGapMs });
    this.signal = signal;
    this.onEvent = onEvent;
    this.report = { version: 1, startedAt: new Date().toISOString(), settings: { initialWaitMs, settleMs, sampleGapMs }, events: [], observations: [], actions: [], errors: [] };
  }
  event(type, details = {}) {
    const event = { type, at: new Date().toISOString(), ...details };
    this.report.events.push(event);
    this.onEvent(event);
  }
  async open(url) {
    await mkdir(this.outputDir, { recursive: true });
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use an HTTP(S) demo URL without credentials');
    this.report.url = url;
    const started = Date.now();
    this.event('navigation-started');
    try {
      const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      this.report.httpStatus = response?.status() ?? null;
      if (this.report.httpStatus >= 400) this.report.errors.push({ phase: 'navigation', message: 'HTTP ' + this.report.httpStatus });
    } catch (error) {
      this.report.errors.push({ phase: 'navigation', message: String(error.message).slice(0, 500) });
    }
    await delay(Math.max(0, this.initialWaitMs - (Date.now() - started)), this.signal);
    this.report.initialWaitElapsedMs = Date.now() - started;
    this.event('initial-wait-complete', { elapsedMs: this.report.initialWaitElapsedMs });
    return this.observe('initial');
  }
  async observe(reason) {
    this.signal?.throwIfAborted();
    const started = performance.now();
    const observed = await this.detector.observe(this.page, { signal: this.signal });
    const index = this.report.observations.length;
    const filename = String(index).padStart(3, '0') + '-' + reason.replace(/[^a-z0-9-]/gi, '-') + '.png';
    const shotPath = path.join(this.outputDir, filename);
    const screenshot = await this.page.screenshot({ path: shotPath, fullPage: false, scale: 'css', timeout: 15000 });
    const ocr = await readScreenshotText(shotPath, { signal: this.signal });
    if (ocr.status !== 'ok' && !this.report.errors.some(e => e.phase === 'ocr')) this.report.errors.push({ phase: 'ocr', message: ocr.error });
    const state = { ...observed, index, reason, screenshot: filename, screenshotSha256: createHash('sha256').update(screenshot).digest('hex'), screenshotAt: new Date().toISOString(), viewport: this.page.viewportSize(), ocr, elapsedMs: Math.round(performance.now() - started) };
    this.report.observations.push(state);
    this.event('observed', { index, reason, controls: state.controls.length, available: state.controls.filter(c => c.availability === 'available').length, transient: state.transient.length, elapsedMs: state.elapsedMs });
    await this.save();
    return state;
  }
  async clickPoint(candidate, kind) {
    this.signal?.throwIfAborted();
    const viewport = this.page.viewportSize();
    if (candidate.kind === 'ocr') {
      // Re-read a small target crop and compare its pixels after OCR, immediately before input.
      const b = candidate.bounds;
      const clip = { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8) };
      clip.width = Math.min(viewport.width - clip.x, b.width + 16);
      clip.height = Math.min(viewport.height - clip.y, b.height + 16);
      const cropPath = path.join(this.outputDir, 'action-crop-' + this.report.actions.length + '.png');
      const first = await this.page.screenshot({ path: cropPath, clip, scale: 'css', timeout: 15000 });
      const text = await readScreenshotText(cropPath, { signal: this.signal, timeoutMs: 3000 });
      const now = await this.page.screenshot({ clip, scale: 'css', timeout: 15000 });
      const normalized = value => value.toLowerCase().replace(/\W+/g, ' ').trim();
      if (!first.equals(now) || text.status !== 'ok' || !text.lines.some(line => normalized(line.text) === normalized(candidate.text))) {
        throw new Error('OCR target changed before input');
      }
    } else {
      // No screenshot/OCR/model latency is allowed between this fresh control check and input.
      const fresh = await this.detector.observe(this.page, { signal: this.signal });
      const current = fresh.controls.find(c => c.id === candidate.id && c.availability === 'available');
      if (!sameCandidate(candidate, current && { ...current, text: current.label || current.text || current.name || '' })) {
        throw new Error('Control identity or geometry changed before input');
      }
      candidate = { ...current, text: candidate.text };
    }
    const { x, y, width, height } = candidate.bounds;
    const point = candidate.hitPoint || { x: x + width / 2, y: y + height / 2 };
    if (!viewport || point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) throw new Error('Candidate left the viewport');
    const action = { kind, candidateId: candidate.id, text: candidate.text, point, dispatchedAt: new Date().toISOString(), inputDispatched: false, actionConfirmed: false };
    this.report.actions.push(action);
    await this.page.mouse.click(point.x, point.y, { timeout: 3000 });
    action.inputDispatched = true;
    this.event('input-dispatched', { kind, candidateId: candidate.id });
    const settledAt = Date.now();
    await delay(this.settleMs, this.signal);
    action.settleElapsedMs = Date.now() - settledAt;
    this.event('post-action-wait-complete', { elapsedMs: action.settleElapsedMs });
    return action;
  }
  async resolveIntros(state, maxSteps = 3) {
    for (let step = 0; step < maxSteps; step++) {
      const candidates = introCandidates(state);
      if (!candidates.length) return state;
      if (!this.laya) {
        this.report.errors.push({ phase: 'intro', message: 'Laya is required for intro decisions' });
        return state;
      }
      let decision;
      const modelCandidates = candidates.map(({ text, kind }, i) => ({ id: 'c' + i, text: text.slice(0, 160), kind }));
      const modelInput = { text: modelCandidates.map(c => c.text).join('\n'), candidates: modelCandidates };
      try {
        // Candidate-centered context avoids unrelated catalogue prose exhausting the model window.
        decision = await this.laya.classifyIntro(modelInput);
      } catch (error) {
        this.report.errors.push({ phase: 'laya', message: String(error.message).slice(0, 500) });
        return state;
      }
      this.event('laya-decision', { input: modelInput, decision });
      const modelChoice = validateDecision(decision, modelCandidates);
      const chosen = modelChoice ? candidates[modelCandidates.indexOf(modelChoice)] : null;
      if (!chosen) return state;
      const revalidated = await this.observe('intro-revalidate');
      const current = introCandidates(revalidated).find(c => c.id === chosen.id);
      if (!sameCandidate(chosen, current)) {
        this.event('stale-intro-rejected', { candidateId: chosen.id });
        return revalidated;
      }
      const action = await this.clickPoint(current, 'intro');
      state = await this.observe('after-intro');
      action.promptDisappeared = !introCandidates(state).some(c => c.id === chosen.id);
      action.observationIndex = state.index;
      if (!action.promptDisappeared) {
        this.event('unchanged-intro-stopped', { candidateId: chosen.id });
        return state;
      }
    }
    this.event('intro-step-limit', { maxSteps });
    return state;
  }
  async actOnControl(expected) {
    // Every caller-selected action must be revalidated on the current page.
    if (!expected || typeof expected !== 'object' || !expected.id) throw new Error('Pass the observed control, preserving its identity and meaning');
    const before = await this.observe('action-revalidate');
    const control = before.controls.find(c => c.id === expected.id);
    const label = c => c && ({ ...c, text: c.label || c.text || c.name || '' });
    if (!control || !control.stable || control.availability !== 'available' || !sameCandidate(label(expected), label(control))) throw new Error('Control is no longer available with the same meaning: ' + expected.id);
    const action = await this.clickPoint({ ...control, text: control.label || control.text || control.name || '' }, 'explicit-control');
    const after = await this.observe('after-action');
    action.observationIndex = after.index;
    action.stateChanged = JSON.stringify(before.controls.map(c => [c.id, c.availability, c.label])) !== JSON.stringify(after.controls.map(c => [c.id, c.availability, c.label]));
    await this.save();
    return after;
  }
  async save() {
    await writeFile(path.join(this.outputDir, 'report.json'), JSON.stringify(this.report, null, 2) + '\n');
  }
}
