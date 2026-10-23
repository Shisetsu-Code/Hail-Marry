import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Only the HTTP boundary is mocked. All inputs, layout and image decoding run in Chromium.
let browser, server, baseUrl, context, page, image, games, received, unauthorized, imageDelay, mutationDelay, asyncMode, revision;
const key = 'ui-test-only-key';
function screen(gameId, ordinal = 1) {
  return { id: `${gameId}-s${ordinal}`, gameId, sessionId: `${gameId}-session`, revision: ordinal, imageSha256: String(ordinal).repeat(64), imageUrl: `/api/images/${gameId}-${ordinal}.jpg`, width: 1200, height: 600, route: [], candidates: [], createdAt: new Date().toISOString() };
}
function initialGame(id) {
  const s = screen(id);
  return { id, title: `Juego ${id.toUpperCase()}`, provider: 'Demo Studio', status: 'ready', busy: false, error: null, finished: false, spinControlId: null, screen: s, screens: [s], controls: [], actions: [] };
}
function send(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || process.env.GUIDED_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
  const source = await browser.newPage({ viewport: { width: 1200, height: 600 } });
  await source.setContent('<style>body{margin:0;background:#172736;color:#c3e6d0;font:32px sans-serif;display:grid;place-items:center;height:600px}div{border:3px solid #8cbba1;padding:50px}</style><div>DEMO · CAPTURA DE PRUEBA</div>');
  image = await source.screenshot({ type: 'jpeg' });
  await source.close();
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const filename = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' }[url.pathname];
      if (!filename) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(await readFile(new URL(`../public/${filename}`, import.meta.url))); return;
    }
    if (req.headers.authorization !== `Bearer ${key}`) { unauthorized.push(req.url); send(res, { error: 'Clave no válida' }, 401); return; }
    if (url.pathname === '/api/state') { send(res, { schemaVersion: 1, runId: 'ui-fixture', revision, games, persistence: { status: 'saved' } }); return; }
    if (url.pathname === '/api/export') { received.push({ type: 'export', auth: req.headers.authorization }); send(res, { schemaVersion: 1, games }); return; }
    if (url.pathname.startsWith('/api/images/')) {
      received.push({ type: 'image', path: req.url, auth: req.headers.authorization });
      await pause(imageDelay);
      if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(image); }
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body), parts = url.pathname.split('/'), g = games.find((item) => item.id === parts[3]);
    received.push({ type: parts[4], gameId: g.id, method: req.method, data, auth: req.headers.authorization });
    if (data.screenId !== g.screen.id || data.revision !== g.screen.revision || data.imageSha256 !== g.screen.imageSha256) { send(res, { error: 'Captura obsoleta' }, 409); return; }
    const apply = () => {
      if (parts[4] === 'mark') {
        const control = { ...data, id: `c${g.controls.length + 1}`, gameId: g.id, screenId: g.screen.id, sessionId: g.screen.sessionId, role: data.mode, executed: data.execute };
        g.controls.push(control);
        if (data.mode === 'spin') g.spinControlId = control.id;
        if (data.mode === 'spin_only') g.finished = true;
        if (data.execute) {
          const next = { ...screen(g.id, g.screens.length + 1), parentScreenId: g.screen.id, viaControlId: control.id, route: [...g.screen.route, control.id] };
          g.actions.push({ id: `a${g.actions.length + 1}`, controlId: control.id, status: 'dispatched', confirmation: { status: 'unknown', reason: 'Pendiente de revisión' } });
          g.screens.push(next); g.screen = next;
        }
      } else if (parts[4] === 'finish') g.finished = true;
      else if (parts[4] === 'controls') g.controls = g.controls.filter((c) => c.id !== parts[5]);
      else if (parts[4] === 'action') { g.controls.find((c) => c.id === data.controlId).executed = true; g.actions.push({ controlId: data.controlId, status: 'dispatched' }); }
      g.busy = false; revision++;
    };
    if (asyncMode) {
      g.busy = true;
      send(res, { game: g }, 202);
      setTimeout(apply, mutationDelay || 250);
    } else { await pause(mutationDelay); apply(); send(res, { game: g }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); await new Promise((resolve) => server?.close(resolve)); });
beforeEach(async () => {
  games = [initialGame('a'), initialGame('b')]; received = []; unauthorized = []; imageDelay = 0; mutationDelay = 0; asyncMode = false; revision = 1;
  context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
});
afterEach(async () => { await context.close(); });
async function open() {
  await page.goto(`${baseUrl}/#key=${key}`);
  await page.locator('#image-wrap').waitFor({ state: 'visible' });
  await page.locator('#refresh:not(:disabled)').waitFor();
}
async function clickAt(x = .5, y = .5) {
  const rect = await page.locator('#screenshot').boundingBox();
  await page.mouse.click(rect.x + rect.width * x, rect.y + rect.height * y);
}
const marks = () => received.filter((r) => r.type === 'mark');
async function waitMarks(count) { await page.waitForFunction((count) => document.querySelectorAll('.control-card').length === count, count); }
async function ready() { await page.waitForFunction(() => !document.querySelector('#finish').disabled); }

test('authenticates state, image and export; removes URL key; supports key form', async () => {
  await open();
  await page.screenshot({ path: new URL('../../artifacts/guided-work/ui-desktop.png', import.meta.url).pathname, fullPage: true });
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('guidedClassifierKey')), key);
  assert.match(await page.locator('#screenshot').getAttribute('src'), /^blob:/);
  const download = page.waitForEvent('download');
  await page.locator('#export').click();
  assert.equal((await download).suggestedFilename(), 'hail-marry-ui-fixture.json');
  assert(received.some((r) => r.type === 'export'));
  assert(received.filter((r) => r.type === 'image').every((r) => r.auth === `Bearer ${key}`));
  assert.deepEqual(unauthorized, []);
  await context.clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(baseUrl);
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  await page.locator('#access-key').fill(key);
  await page.locator('#auth-form button').click();
  await page.locator('#image-wrap').waitFor({ state: 'visible' });
});

test('five modes and Q preserve save/execute semantics, identities and distinct menu routes', async () => {
  await open();
  await page.keyboard.press('2'); await clickAt();
  assert.equal(marks().length, 0, 'Antebet must require an existing Spin');
  await page.keyboard.press('1'); await clickAt(.2, .25); await waitMarks(1);
  assert.equal(marks()[0].data.mode, 'spin'); assert.equal(marks()[0].data.execute, false);
  await page.keyboard.press('2'); await clickAt(.3, .4); await waitMarks(2); await ready();
  await page.keyboard.press('3'); await clickAt(.4, .5); await waitMarks(3); await ready();
  await page.keyboard.press('3'); await clickAt(.45, .55); await waitMarks(4); await ready();
  await page.keyboard.press('4'); await clickAt(.6, .6); await waitMarks(5); await ready();
  await page.keyboard.press('q'); await clickAt(.7, .7); await waitMarks(6); await ready();
  assert.deepEqual(marks().map((r) => r.data.mode), ['spin', 'antebet', 'menu', 'menu', 'buy', 'continue']);
  assert(marks().slice(1).every((r) => r.data.execute === true));
  assert.notEqual(marks()[2].data.screenId, marks()[3].data.screenId);
  assert.equal(new Set(marks().map((r) => r.data.requestId)).size, 6);
  for (const { data } of marks()) { assert.match(data.requestId, /^[0-9a-f-]{36}$/); assert(data.screenId); assert(Number.isInteger(data.revision)); assert.equal(data.imageSha256.length, 64); }
  await page.locator('[data-game-id="b"]').click(); await ready();
  await page.keyboard.press('5'); await clickAt(.8, .8);
  await page.waitForFunction(() => document.querySelector('[data-game-id="b"] .game-status').textContent.includes('Finalizado'));
  assert.equal(marks().at(-1).data.mode, 'spin_only'); assert.equal(marks().at(-1).data.execute, false);
  assert.equal(games[1].actions.length, 0);
});

test('coordinates follow the rendered image at desktop and narrow widths; old images cannot receive clicks', async () => {
  await open();
  await clickAt(.25, .75); await waitMarks(1);
  assert(Math.abs(marks()[0].data.x - .25) < .003); assert(Math.abs(marks()[0].data.y - .75) < .003);
  await page.setViewportSize({ width: 740, height: 900 });
  await clickAt(.8, .2); await waitMarks(2);
  assert(Math.abs(marks()[1].data.x - .8) < .003); assert(Math.abs(marks()[1].data.y - .2) < .003);
  imageDelay = 450;
  await page.locator('[data-game-id="b"]').click();
  assert.equal(await page.locator('#image-wrap').isVisible(), false);
  await page.locator('#stage').click();
  assert.equal(marks().length, 2);
  await page.locator('#image-wrap').waitFor({ state: 'visible' }); await clickAt(.1, .9); await waitMarks(1);
  assert.equal(marks().at(-1).gameId, 'b'); assert.equal(marks().at(-1).data.screenId, 'b-s1');
  assert(Math.abs(marks().at(-1).data.x - .1) < .004);
});

test('focused fields, editable content, modifiers and repeated keys never change mode or send input', async () => {
  await open();
  await page.locator('#mark-label').focus(); await page.keyboard.type('2345q');
  assert.equal(await page.locator('[data-mode="spin"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#mark-label').blur();
  await page.evaluate(() => { const edit = document.createElement('div'); edit.contentEditable = 'true'; edit.id = 'editable-fixture'; document.body.append(edit); edit.focus(); });
  await page.keyboard.press('4');
  assert.equal(await page.locator('[data-mode="spin"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#editable-fixture').evaluate((el) => el.remove());
  await page.keyboard.press('Control+4');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', repeat: true, bubbles: true })));
  assert.equal(await page.locator('[data-mode="spin"]').getAttribute('aria-pressed'), 'true');
  assert.equal(marks().length, 0);
  await page.keyboard.press('q'); await clickAt(); await waitMarks(1);
  assert.equal(marks()[0].data.mode, 'continue');
});

test('suppresses double clicks and overlapping requests, including 202 processing; finishes next game', async () => {
  await open();
  asyncMode = true; mutationDelay = 500;
  const rect = await page.locator('#screenshot').boundingBox();
  await page.mouse.dblclick(rect.x + rect.width * .5, rect.y + rect.height * .5);
  await page.locator('#finish:disabled').waitFor();
  await page.keyboard.press('q');
  await page.locator('#stage').click();
  await waitMarks(1); await ready();
  assert.equal(marks().length, 1);
  await page.locator('#finish').click();
  await page.waitForFunction(() => document.querySelector('[data-game-id="b"]').getAttribute('aria-pressed') === 'true');
  assert.equal(received.filter((r) => r.type === 'finish').length, 1);
});

test('mark-only roles, execute/delete, history inspection and refresh are usable', async () => {
  await open();
  await page.locator('#mark-only').check();
  for (const [i, role] of ['menu', 'option', 'confirm', 'cancel', 'back', 'bet'].entries()) {
    await page.locator(`[data-mode="${role}"]`).click(); await clickAt(.15 + i * .1, .5); await waitMarks(i + 1); await ready();
  }
  assert(marks().every((r) => r.data.execute === false));
  assert.deepEqual(marks().map((r) => r.data.mode), ['menu', 'option', 'confirm', 'cancel', 'back', 'bet']);
  await page.locator('.delete-control').last().click(); await waitMarks(5); await ready();
  assert.equal(received.at(-1).type, 'controls');
  await page.locator('.execute-control').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.execute-control').length === 4); await ready();
  assert.equal(received.filter((r) => r.type === 'action').length, 1);
  await page.locator('#mark-only').uncheck();
  await page.locator('[data-mode="menu"]').click(); await clickAt(); await waitMarks(6); await ready();
  await page.locator('#history').selectOption('a-s1');
  assert.equal(await page.locator('#finish').isDisabled(), true);
  const before = marks().length; await clickAt(); assert.equal(marks().length, before);
  await page.locator('#history').selectOption(''); await ready();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.equal(received.filter((r) => r.type === 'refresh').length, 1);
});
