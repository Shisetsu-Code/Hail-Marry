import test from 'node:test';
import assert from 'node:assert/strict';
import { introCandidates, sameCandidate, validateDecision } from '../src/intro.mjs';

test('only explicit continuation prompts become intro candidates; a canvas is not a button', () => {
  const state = { controls: [
    { id: 'continue', label: 'Click to continue', availability: 'available', stable: true, bounds: { x: 10, y: 20, width: 100, height: 30 } },
    { id: 'buy', label: 'Buy bonus', availability: 'available', stable: true },
    { id: 'canvas', label: 'canvas', availability: 'available', stable: true },
    { id: 'start', label: 'Start', availability: 'available', stable: true, bounds: { x: 5, y: 5, width: 60, height: 20 } },
    { id: 'disabled', label: 'Continue', availability: 'unavailable', stable: true },
  ], ocr: { lines: [{ text: 'SPIN', confidence: 99 }, { text: 'TAP TO START', confidence: 90, bounds: { x: 30, y: 40, width: 150, height: 30 } }] } };
  assert.deepEqual(introCandidates(state).map(c => c.id), ['continue', 'ocr:tap to start']);
});

test('an Laya choice cannot escape the observed candidate list or confidence gate', () => {
  const candidates = [{ id: 'continue', text: 'Continue' }];
  const base = { status: 'ok', action: 'continue', candidateId: 'continue', confidence: .95, inference: true };
  assert.equal(validateDecision(base, candidates)?.id, 'continue');
  for (const patch of [{ candidateId: 'spin' }, { confidence: .4 }, { inference: false }, { status: 'needs_review' }, { action: 'buy' }]) {
    assert.equal(validateDecision({ ...base, ...patch }, candidates), null);
  }
});

test('a short OCR continue prompt requires agreeing readings; Start remains ambiguous', () => {
  const bounds = { x: 146, y: 559, width: 131, height: 16 };
  const line = { text: 'CONTINUE', confidence: 95, bounds };
  assert.deepEqual(introCandidates({ ocr: { lines: [line] } }), []);
  assert.deepEqual(introCandidates({ ocr: { lines: [{ ...line, readings: ['warm-red', 'warm-red'] }] } }), []);
  const candidates = introCandidates({ ocr: { lines: [{ ...line, readings: ['warm-red', 'warm-green'] }] } });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'ocr:continue');
  assert.deepEqual(introCandidates({ ocr: { lines: [{ ...line, text: 'START', readings: ['warm-red', 'warm-green'] }] } }), []);
});

test('revalidation rejects stale coordinates and text, even when IDs are reused', () => {
  const a = { id: 'a', text: 'Tap to start', bounds: { x: 20, y: 30, width: 100, height: 40 } };
  assert.equal(sameCandidate(a, { ...a, bounds: { ...a.bounds, x: 23 } }), true);
  assert.equal(sameCandidate(a, { ...a, text: 'Buy bonus' }), false);
  assert.equal(sameCandidate(a, { ...a, bounds: { ...a.bounds, x: 80 } }), false);
});
