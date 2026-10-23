import assert from 'node:assert/strict';
import test from 'node:test';

// Literal snapshots model the detector's external observation boundary, not browser internals.
import { reconcileSamples, ControlStateDetector } from '../src/detector.mjs';

function control(overrides = {}) {
  return {
    id: 'frame-1:dom:button#spin', source: 'dom', label: 'Spin', role: 'button',
    visible: true, enabled: true, interactable: true, geometryReliable: true,
    bounds: { x: 100, y: 80, width: 60, height: 30 },
    observedAt: '2026-10-23T12:00:00.000Z',
    evidence: { kind: 'dom-hit-test', receivesInput: true }, ...overrides,
  };
}
function samples(before, after) {
  return [
    { observedAt: '2026-10-23T12:00:00.000Z', controls: before },
    { observedAt: '2026-10-23T12:00:00.300Z', controls: after.map((c) => ({ ...c, observedAt: '2026-10-23T12:00:00.300Z' })) },
  ];
}

test('two matching input observations make a control available without claiming action effects', () => {
  assert.equal(typeof reconcileSamples, 'function', 'snapshot reconciliation is implemented');
  const result = reconcileSamples(...samples([control()], [control()]));
  assert.equal(result.controls[0].availability, 'available');
  assert.equal(result.controls[0].stable, true);
  assert.equal(result.controls[0].actionConfirmed, false);
  assert.equal(result.controls[0].persistence.gapMs, 300);
});

test('a momentarily enabled control is unavailable and retains both observations', () => {
  const disabled = control({ enabled: false, interactable: false, evidence: { kind: 'dom-hit-test', receivesInput: false } });
  const result = reconcileSamples(...samples([control()], [disabled]));
  assert.equal(result.controls[0].availability, 'unavailable');
  assert.equal(result.controls[0].stable, false);
  assert.equal(result.transient[0].reason, 'state-changed');
  assert.equal(result.transient[0].before.enabled, true);
  assert.equal(result.transient[0].after.enabled, false);
});

test('appearing and disappearing controls do not acquire persistent availability', () => {
  const result = reconcileSamples(...samples([control()], [control({ id: 'frame-1:dom:button#bonus' })]));
  assert.equal(result.controls[0].availability, 'unknown');
  assert.deepEqual(result.transient.map((entry) => entry.reason).sort(), ['appeared', 'disappeared']);
  assert.equal(result.transient.find((entry) => entry.reason === 'disappeared').before.enabled, true);
});

test('private engine flags remain unknown even when their booleans are stable', () => {
  const hint = control({ source: 'uht', evidence: { kind: 'engine-flags', receivesInput: null }, interactable: null });
  const result = reconcileSamples(...samples([hint], [hint]));
  assert.equal(result.controls[0].availability, 'unknown');
  assert.equal(result.controls[0].interactable, null);
});

test('large geometry changes prevent availability but preserve the moved control', () => {
  const moved = control({ bounds: { x: 130, y: 80, width: 60, height: 30 } });
  const result = reconcileSamples(...samples([control()], [moved]));
  assert.equal(result.controls[0].availability, 'unknown');
  assert.equal(result.transient[0].reason, 'bounds-changed');
});

test('samples outside the 200–400 ms window cannot establish availability', () => {
  const [before, after] = samples([control()], [control()]);
  after.controls[0].observedAt = '2026-10-23T12:00:01.100Z';
  const result = reconcileSamples(before, after);
  assert.equal(result.controls[0].availability, 'unknown');
  assert.equal(result.controls[0].persistence.reason, 'sampling-gap-outside-window');
});

test('missing current evidence timestamps cannot be replaced with an old successful observation', () => {
  const [before, after] = samples([control()], [control()]);
  delete after.controls[0].observedAt;
  const result = reconcileSamples(before, after);
  assert.equal(result.controls[0].availability, 'unknown');
});

test('sampling options reject a gap that could accept millisecond flicker', () => {
  assert.equal(typeof ControlStateDetector, 'function', 'detector is implemented');
  assert.throws(() => new ControlStateDetector({ sampleGapMs: 10 }), /200.*400/);
});

test('navigation cannot reuse a matching control as persistence from the previous document', () => {
  const result = reconcileSamples(...samples(
    [control({ frameUrl: 'https://example.test/old' })],
    [control({ frameUrl: 'https://example.test/new' })],
  ));
  assert.equal(result.controls[0].availability, 'unknown');
  assert.equal(result.transient[0].reason, 'identity-changed');
});

test('a browser evaluation that never settles produces bounded incomplete coverage', async () => {
  // The non-settling browser protocol boundary is deliberate: an infinite browser script
  // would hang a test browser too. Merging and all timeout/abort logic remain real.
  const frame = { evaluate: () => new Promise(() => {}) };
  const page = { frames: () => [frame] };
  const start = Date.now();
  const result = await new ControlStateDetector({ scanTimeoutMs: 30, sampleGapMs: 200 }).observe(page);
  assert.ok(Date.now() - start < 800);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.controls.length, 0);
  assert.equal(result.coverage.samples[0].errors[0].error, 'Read-only scan deadline exceeded');
  assert.equal(result.coverage.samples[1].errors[0].error, 'Read-only scan deadline exceeded');
});
