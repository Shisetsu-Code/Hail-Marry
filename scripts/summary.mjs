import { readFile, appendFile } from 'node:fs/promises';
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
const [laya, fixture, live] = await Promise.all(['artifacts/laya-smoke.json', 'artifacts/fixture/result.json', 'artifacts/live/summary.json'].map(json));
const lines = ['# Hail-Marry experiment', '', '## Controlled checks', '',
  '- Real Laya: ' + (laya ? laya.results.map(r => r.name + '=' + r.result.action + ' (' + r.result.elapsedMs + 'ms)').join('; ') : 'no result'),
  '- Fixture: ' + (fixture?.status || 'no result')];
if (fixture?.checks) lines.push(...fixture.checks.map(check => '- ' + check));
lines.push('', '## Public demo observations', '', '| Demo | Result | Controls | Available | Inputs |', '|---|---|---:|---:|---:|');
for (const item of live?.results || []) {
  const r = item.value || {};
  lines.push('| ' + (r.id || 'session') + ' | ' + (r.status || item.status) + ' | ' + (r.controls ?? '') + ' | ' + (r.available ?? '') + ' | ' + (r.actions ?? '') + ' |');
}
lines.push('', 'Available means sampled input availability; it does not prove a game action or a complete loading state. Inspect JSON and PNG artifacts for coverage and pending introductions.', '');
const text = lines.join('\n');
process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
