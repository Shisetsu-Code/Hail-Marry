import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { LayaClient } from '../src/laya-client.mjs';
const client = new LayaClient({ timeoutMs: 45000 });
const health = await client.health();
const cases = [
  { name: 'intro', input: { text: 'Welcome to the game. CLICK TO CONTINUE', candidates: [{ id: 'c0', text: 'CLICK TO CONTINUE', kind: 'ocr' }] } },
  { name: 'gameplay', input: { text: 'Balance 1000.00. Bet 1.00. SPIN. BUY BONUS.', candidates: [{ id: 'c0', text: 'SPIN', kind: 'control' }, { id: 'c1', text: 'BUY BONUS', kind: 'control' }] } },
];
const results = [];
for (const item of cases) {
  const result = await client.classifyIntro(item.input);
  results.push({ name: item.name, result });
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
