import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { LayaClient } from '../src/laya-client.mjs';
const client = new LayaClient({ timeoutMs: 45000 });
const health = await client.health();
const cases = [
  { name: 'intro', input: { text: 'Welcome to the game. CLICK TO CONTINUE', candidates: [{ id: 'c0', text: 'CLICK TO CONTINUE', kind: 'ocr' }] } },
  { name: 'gameplay', input: { text: 'Balance 1000.00. Bet 1.00. SPIN. BUY BONUS.', candidates: [{ id: 'c0', text: 'SPIN', kind: 'control' }, { id: 'c1', text: 'BUY BONUS', kind: 'control' }] } },
  { name: 'session-ocr-exact', input: { text: 'CLICK TO CONTINUE', candidates: [{ id: 'c0', text: 'CLICK TO CONTINUE', kind: 'ocr' }] } },
  { name: 'label-titlecase', input: { text: 'Click to continue', candidates: [{ id: 'c0', text: 'Click to continue', kind: 'ocr' }] } },
  { name: 'welcome-context', input: { text: 'Welcome. CLICK TO CONTINUE', candidates: [{ id: 'c0', text: 'CLICK TO CONTINUE', kind: 'ocr' }] } },
  { name: 'spin-only', input: { text: 'SPIN', candidates: [{ id: 'c0', text: 'SPIN', kind: 'control' }] } },
  { name: 'buy-only', input: { text: 'BUY BONUS', candidates: [{ id: 'c0', text: 'BUY BONUS', kind: 'control' }] } },
  { name: 'session-ocr-anywhere', input: { text: 'CLICK ANYWHERE TO START', candidates: [{ id: 'c0', text: 'CLICK ANYWHERE TO START', kind: 'ocr' }] } },
  { name: 'session-ocr-continue', input: { text: 'CONTINUE', candidates: [{ id: 'c0', text: 'CONTINUE', kind: 'ocr' }] } },
  { name: 'session-ocr-bordered-continue', input: { text: '| CONTINUE', candidates: [{ id: 'c0', text: '| CONTINUE', kind: 'ocr' }] } },
  { name: 'session-ocr-tap', input: { text: 'TAP TO CONTINUE', candidates: [{ id: 'c0', text: 'TAP TO CONTINUE', kind: 'ocr' }] } },
  { name: 'mixed-controls', input: { text: 'CLICK TO CONTINUE', candidates: [{ id: 'c0', text: 'SPIN', kind: 'control' }, { id: 'c1', text: 'CLICK TO CONTINUE', kind: 'ocr' }, { id: 'c2', text: 'BUY BONUS', kind: 'control' }] } },
  { name: 'mixed-controls-reordered', input: { text: 'CLICK TO CONTINUE', candidates: [{ id: 'c0', text: 'BUY BONUS', kind: 'control' }, { id: 'c1', text: 'SPIN', kind: 'control' }, { id: 'c2', text: 'CLICK TO CONTINUE', kind: 'ocr' }] } },
  { name: 'purchase-to-continue', input: { text: 'BUY BONUS TO CONTINUE', candidates: [{ id: 'c0', text: 'BUY BONUS TO CONTINUE', kind: 'control' }] } },
];
const results = [];
for (const item of cases) {
  const result = await client.classifyIntro(item.input);
  results.push({ ...item, result });
}
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/laya-smoke.json', JSON.stringify({ health, results }, null, 2));
process.stdout.write(JSON.stringify({ health, results }, null, 2) + '\n');
assert.equal(results[0].result.inference, true);
assert.equal(results[0].result.status, 'ok');
assert.equal(results[0].result.action, 'continue');
assert.equal(results[0].result.candidateId, 'c0');
assert.equal(results[1].result.inference, true);
assert.equal(results[1].result.action, 'none');
for (const [name, candidateId] of [
  ['session-ocr-exact', 'c0'],
  ['session-ocr-tap', 'c0'],
  ['mixed-controls', 'c1'],
  ['mixed-controls-reordered', 'c2'],
]) {
  const result = results.find(item => item.name === name).result;
  assert.equal(result.inference, true, name);
  assert.equal(result.status, 'ok', name);
  assert.equal(result.action, 'continue', name);
  assert.equal(result.candidateId, candidateId, name);
  assert.ok(result.confidence >= 0.80, name);
}
for (const name of ['spin-only', 'buy-only', 'purchase-to-continue']) {
  const result = results.find(item => item.name === name).result;
  assert.equal(result.inference, true);
  assert.equal(result.action, 'none', name + ' must never authorize an intro click');
}
