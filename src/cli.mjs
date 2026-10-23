import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { GameSession } from './session.mjs';
import { LayaClient } from './laya-client.mjs';
import { mapConcurrent } from './timing.mjs';
import { demoLaunchUrl } from './launcher.mjs';
import { introCandidates } from './intro.mjs';

function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Arguments require --name value');
    args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}
const args = argsOf(process.argv.slice(2));
const outputDir = path.resolve(args.out || 'artifacts/live');
const config = args.url ? { demos: [{ id: 'custom-demo', url: args.url }] } : JSON.parse(await readFile(args.config || 'config/demos.json', 'utf8'));
const limit = Number(args.concurrency || 3);
const initialWaitMs = Number(args['initial-wait-ms'] || 60000);
if (!Array.isArray(config.demos) || !config.demos.length) throw new Error('No demo targets configured');
const ids = config.demos.map(target => String(target.id).replace(/[^a-z0-9_-]/gi, '-'));
if (new Set(ids).size !== ids.length) throw new Error('Demo IDs must remain unique after filename sanitization');
if (initialWaitMs < 60000) throw new Error('Live probes require the requested 60-second initial wait');
await mkdir(outputDir, { recursive: true });
const started = Date.now();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const laya = new LayaClient({ baseUrl: process.env.LAYA_URL || 'http://127.0.0.1:8765', timeoutMs: 45000 });
let results;
try {
  results = await mapConcurrent(config.demos, limit, async target => {
    const id = target.id.replace(/[^a-z0-9_-]/gi, '-');
    const context = await browser.newContext(target.device ? devices[target.device] : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(new Error('Demo session deadline exceeded')); void context.close().catch(() => {}); }, 240000);
    const session = new GameSession(page, { outputDir: path.join(outputDir, id), laya, initialWaitMs, signal: controller.signal, onEvent: event => process.stdout.write(JSON.stringify({ target: id, ...event }) + '\n') });
    try {
      session.report.sourceUrl = target.url;
      let state = await session.open(demoLaunchUrl(target));
      state = await session.resolveIntros(state);
      // Explicit config actions are exact labels, bounded and revalidated; none ship for live demos.
      for (const requested of (target.actions || []).slice(0, 4)) {
        const controls = state.controls.filter(c => c.availability === 'available' && String(c.label || c.text || '').toLowerCase() === requested.label.toLowerCase());
        if (controls.length !== 1) { session.event('explicit-action-unavailable', { label: requested.label }); break; }
        state = await session.actOnControl(controls[0]);
      }
      const available = state.controls.filter(c => c.availability === 'available');
      const inputControlsObserved = available.length > 0;
      const stableEnabledCandidates = state.controls.filter(c => c.stable && c.visible === true && c.enabled === true).length;
      const pendingIntro = introStillPresent(state);
      const status = session.report.errors.length ? 'needs_review' : pendingIntro ? 'intro_pending' : inputControlsObserved ? 'input_controls_observed' : 'needs_review';
      return { id, provider: target.provider, status, available: available.length, stableEnabledCandidates, controls: state.controls.length, transient: state.transient.length, actions: session.report.actions.length, coverage: state.coverage, report: id + '/report.json' };
    } catch (error) {
      session.report.errors.push({ phase: 'session', message: String(error.message) });
      return { id, status: 'failed', error: String(error.message), report: id + '/report.json' };
    } finally {
      clearTimeout(timeout);
      session.report.finishedAt = new Date().toISOString();
      await session.save().catch(error => process.stderr.write('Report save error: ' + error.message + '\n'));
      await context.close();
    }
  });
} finally { await browser.close(); }
const summary = { elapsedMs: Date.now() - started, concurrency: limit, initialWaitMs, results };
await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
if (!results.some(result => result.value?.status === 'input_controls_observed')) process.exitCode = 2;

function introStillPresent(state) {
  return introCandidates(state).length > 0;
}
