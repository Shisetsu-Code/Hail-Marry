import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { GameSession } from '../src/session.mjs';
import { demoLaunchUrl } from '../src/launcher.mjs';

test('official Pragmatic launch uses the requested symbol before the load wait', () => {
  const result = new URL(demoLaunchUrl({ requiresLauncher: true, provider: 'pragmatic', symbol: 'vswaysmonkey', url: 'https://www.pragmaticplay.com/en/games/3-dancing-monkeys/' }));
  assert.equal(result.hostname, 'demogamesfree.pragmaticplay.net');
  assert.equal(result.searchParams.get('gameSymbol'), 'vswaysmonkey');
  assert.throws(() => demoLaunchUrl({ requiresLauncher: true, provider: 'unknown' }));
});

test('action loop rejects a reused ID with changed meaning and discovers delayed menu controls', async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hail-session-'));
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const session = new GameSession(page, { outputDir: dir, initialWaitMs: 0 });
    await session.open(fixture.gameUrl + '?mode=dom');
    await page.locator('#intro-continue').click(); // controlled setup only; real OCR/Laya is exercised by Actions.
    let state = await session.observe('base');
    const menu = state.controls.find(c => c.label === 'Menu');
    assert.equal(menu.availability, 'available');
    await page.locator('#menu-button').evaluate(el => { el.textContent = 'Buy bonus'; });
    await assert.rejects(() => session.actOnControl(menu), /same meaning/);
    assert.equal((await page.evaluate(() => window.__fixture.snapshot())).menuClicks, 0);
    await page.locator('#menu-button').evaluate(el => { el.textContent = 'Menu'; });
    state = await session.actOnControl(menu);
    assert.equal(state.controls.find(c => c.label === 'Sound on')?.availability, 'available');
    assert.ok(session.report.actions[0].settleElapsedMs >= 1500);
    assert.equal((await page.evaluate(() => window.__fixture.snapshot())).spinCount, 0);
  } finally {
    await browser.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
