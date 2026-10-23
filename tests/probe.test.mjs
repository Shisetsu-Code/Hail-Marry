import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { probeFrame } from '../src/page-probe.mjs';
import { ControlStateDetector } from '../src/detector.mjs';

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
});
after(async () => { await browser?.close(); });

async function withPage(run) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try { await run(page); } finally { await page.close(); }
}

test('DOM observation distinguishes disabled, hidden and blocked controls without input side effects', async () => {
  await withPage(async (page) => {
    await page.setContent(`<!doctype html><style>body{margin:0}button{width:100px;height:30px;display:block}</style>
      <button id="live" onclick="window.actions++">Live</button>
      <fieldset disabled><button>Fieldset disabled</button></fieldset>
      <div aria-disabled="true"><button>ARIA disabled</button></div>
      <div style="opacity:0"><button>Invisible</button></div>
      <button style="position:absolute;left:200px;top:100px">Covered</button>
      <div style="position:absolute;left:190px;top:90px;width:120px;height:60px;background:black"></div>
      <button style="position:absolute;left:1200px;top:0">Offscreen</button>
      <canvas width="600" height="300" style="cursor:pointer"></canvas>
      <script>window.actions=0;window.focusEvents=0;addEventListener('focusin',()=>window.focusEvents++);</script>`);
    const result = await page.evaluate(probeFrame, { budgetMs: 500 });
    const byLabel = new Map(result.controls.map((control) => [control.label, control]));
    assert.equal(byLabel.get('Live').interactable, true);
    assert.equal(byLabel.get('Fieldset disabled').enabled, false);
    assert.equal(byLabel.get('ARIA disabled').enabled, false);
    assert.equal(byLabel.get('Invisible').visible, false);
    assert.equal(byLabel.get('Covered').interactable, false);
    assert.equal(byLabel.get('Offscreen').visible, false);
    assert.equal(result.controls.some((control) => control.role === 'canvas'), false);
    assert.deepEqual(await page.evaluate(() => [window.actions, window.focusEvents]), [0, 0]);
    assert.equal(await page.locator(byLabel.get('Live').selector).count(), 1);
  });
});

test('open-shadow controls retain executable selectors and actual hit evidence', async () => {
  await withPage(async (page) => {
    await page.setContent('<div id="host"></div>');
    await page.evaluate(() => { document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow play</button>'; });
    const result = await page.evaluate(probeFrame, { budgetMs: 500 });
    const control = result.controls.find((entry) => entry.label === 'Shadow play');
    assert.equal(control.interactable, true);
    assert.equal(await page.locator(control.selector).count(), 1);
  });
});

test('nested and opaque-origin frames map controls into the top-level viewport', async () => {
  await withPage(async (page) => {
    const inner = '<style>body{margin:0}button{position:absolute;left:10px;top:10px;width:60px;height:25px}</style><button>Nested</button>';
    const nestedUrl = 'data:text/html,' + encodeURIComponent(inner);
    const outer = `<style>body{margin:0}button{position:absolute;left:20px;top:10px;width:80px;height:30px}iframe{position:absolute;left:30px;top:50px;width:150px;height:70px;border:2px solid}</style><button>Child</button><iframe src="${nestedUrl}"></iframe>`;
    await page.setContent('<style>body{margin:0}iframe{position:absolute;left:100px;top:80px;width:220px;height:160px;border:4px solid}</style><iframe id="outer"></iframe>');
    await page.locator('#outer').evaluate((element, html) => { element.srcdoc = html; }, outer);
    await page.waitForFunction(() => document.querySelector('#outer').contentDocument?.querySelector('button'));
    await page.waitForTimeout(100);
    const detector = new ControlStateDetector({ frameBudgetMs: 500 });
    const result = await detector.observe(page);
    const child = result.controls.find((entry) => entry.label === 'Child');
    const nested = result.controls.find((entry) => entry.label === 'Nested');
    assert.deepEqual(child.bounds, { x: 124, y: 94, width: 80, height: 30 });
    assert.deepEqual(nested.bounds, { x: 146, y: 146, width: 60, height: 25 });
    assert.equal(child.normalizedBounds.x, 0.155);
    assert.equal(nested.normalizedBounds.x, 0.1825);
    assert.equal(child.availability, 'available');
    assert.equal(nested.availability, 'available');
    assert.notEqual(child.frameId, nested.frameId);
    assert.equal(result.coverage.samples[1].framesScanned, 3);
  });
});

test('an overlay in the parent document blocks a locally hittable iframe control', async () => {
  await withPage(async (page) => {
    await page.setContent(`<style>body{margin:0}iframe{position:absolute;left:30px;top:30px;width:220px;height:160px;border:0}</style>
      <iframe srcdoc="<button>Child covered</button>"></iframe>
      <div style="position:absolute;left:20px;top:20px;width:250px;height:190px;background:black;z-index:4"></div>`);
    await page.waitForTimeout(50);
    const result = await new ControlStateDetector({ frameBudgetMs: 500 }).observe(page);
    const control = result.controls.find((entry) => entry.label === 'Child covered');
    assert.equal(control.interactable, false);
    assert.equal(control.availability, 'unavailable');
    assert.equal(control.evidence.receivesInput, false);
  });
});

test('a millisecond-enabled button is preserved as transient and never reported available', async () => {
  await withPage(async (page) => {
    await page.setContent('<button id="brief">Brief</button>');
    // Run the real first scan, then change the page state. This is a controlled source of
    // observations, not a fake DOM implementation or a substitute for production merging.
    const first = await page.evaluate(probeFrame, { budgetMs: 500 });
    await page.evaluate(() => { document.querySelector('#brief').disabled = true; });
    await page.waitForTimeout(250);
    const second = await page.evaluate(probeFrame, { budgetMs: 500 });
    const { reconcileSamples } = await import('../src/detector.mjs');
    for (const snapshot of [first, second]) for (const c of snapshot.controls) c.id = `frame:${c.source}:${c.localId}`;
    const result = reconcileSamples(first, second);
    assert.equal(result.controls[0].availability, 'unavailable');
    assert.equal(result.transient[0].before.enabled, true);
    assert.equal(result.transient[0].after.enabled, false);
  });
});

test('aborting between samples rejects promptly and sends no input', async () => {
  await withPage(async (page) => {
    await page.setContent('<button onclick="window.actions++">Live</button><script>window.actions=0</script>');
    const controller = new AbortController();
    const pending = new ControlStateDetector({ frameBudgetMs: 500 }).observe(page, { signal: controller.signal });
    setTimeout(() => controller.abort(), 70);
    const startedAt = Date.now();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(Date.now() - startedAt < 250);
    assert.equal(await page.evaluate(() => window.actions), 0);
  });
});

test('a rotated iframe stays unknown instead of offering an inaccurate click coordinate', async () => {
  await withPage(async (page) => {
    await page.setContent('<iframe style="width:200px;height:100px;transform:rotate(8deg);margin:80px" srcdoc="<button>Rotated</button>"></iframe>');
    await page.waitForTimeout(50);
    const result = await new ControlStateDetector({ frameBudgetMs: 500 }).observe(page);
    const control = result.controls.find((entry) => entry.label === 'Rotated');
    assert.notEqual(control.availability, 'available');
    assert.equal(control.geometryReliable, false);
    assert.equal(control.normalizedPoint, null);
  });
});

test('bounded private UHT contract inspection preserves button identity and never invokes input', async () => {
  await withPage(async (page) => {
    await page.setContent('<canvas width="800" height="600" style="position:absolute;left:0;top:0"></canvas>');
    await page.evaluate(() => {
      window.XTButton = function XTButton() {}; window.Camera = function Camera() {}; window.UILabel = function UILabel() {}; window.UISprite = function UISprite() {};
      const go = { name: 'StopSpin_Button', activeInHierarchy: true, layer: 0,
        collider: { enabled: true, GetTransformedCenterAndSize: () => ({ center: { x: 100, y: 80, z: 0 }, size: { x: 60, y: 30, z: 0 } }) },
        GetComponentsInChildren: (type) => type === window.UILabel ? [{ gameObject: { activeInHierarchy: true }, text: 'ananas' }] : [] };
      go.transform = { gameObject: go, parent: null };
      const button = { gameObject: go, enabled: true, xtEnabled: true };
      const camera = { enabled: true, cullingMask: 1, depth: 0, WorldToScreenPoint: (point) => point };
      window.globalRuntime = { sceneRoots: [{ GetComponentsInChildren: (type) => type === window.XTButton ? [button] : type === window.Camera ? [camera] : [] }] };
      window.UHTScreen = { width: 800, height: 600 };
    });
    const result = await new ControlStateDetector({ frameBudgetMs: 500 }).observe(page);
    const control = result.controls.find((entry) => entry.source === 'uht');
    assert.equal(control.label, 'StopSpin_Button');
    assert.deepEqual(control.textHints, ['ananas']);
    assert.equal(control.enabled, true);
    assert.equal(control.interactable, null);
    assert.equal(control.availability, 'unknown');
    assert.deepEqual(control.bounds, { x: 70, y: 65, width: 60, height: 30 });
  });
});

test('UHT projects controls using a matching camera beyond the first eight candidates', async () => {
  await withPage(async (page) => {
    await page.setContent('<canvas width="800" height="600" style="position:absolute;left:0;top:0"></canvas>');
    await page.evaluate(() => {
      window.XTButton = function XTButton() {};
      window.Camera = function Camera() {};
      const go = { name: 'StartSpin_Button', activeInHierarchy: true, layer: 22,
        collider: { enabled: true, GetTransformedCenterAndSize: () => ({ center: { x: 100, y: 80, z: 0 }, size: { x: 60, y: 30, z: 0 } }) } };
      go.transform = { gameObject: go, parent: null };
      const button = { gameObject: go, enabled: true, xtEnabled: true };
      const cameras = Array.from({ length: 12 }, (_, depth) => ({ enabled: true, cullingMask: 1, depth,
        WorldToScreenPoint: (point) => point }));
      cameras.push({ enabled: true, cullingMask: 4194304, depth: 20, WorldToScreenPoint: (point) => point });
      window.globalRuntime = { sceneRoots: [{ GetComponentsInChildren: (type) =>
        type === window.XTButton ? [button] : type === window.Camera ? cameras : [] }] };
      window.UHTScreen = { width: 800, height: 600 };
    });
    const result = await new ControlStateDetector({ frameBudgetMs: 500 }).observe(page);
    const control = result.controls.find((entry) => entry.source === 'uht');
    assert.deepEqual(control.bounds, { x: 70, y: 65, width: 60, height: 30 });
    assert.equal(control.availability, 'unknown');
    const coverage = result.coverage.samples[1].frames[0].engines.find((entry) => entry.engine === 'uht');
    assert.equal(coverage.camerasInspected, 13);
    assert.equal(coverage.canvasCount, 1);
    assert.equal(control.evidence.geometryReason, 'projected-collider-bounds');
  });
});

test('a canvas with a blanket click handler is still a surface rather than a detected control', async () => {
  await withPage(async (page) => {
    await page.setContent('<canvas role="button" onclick="window.actions++" width="400" height="300"></canvas>');
    const result = await page.evaluate(probeFrame, { budgetMs: 500 });
    assert.equal(result.controls.length, 0);
  });
});

test('Pixi flags respect a disabled containing surface', async () => {
  await withPage(async (page) => {
    await page.setContent('<div aria-disabled="true"><canvas width="800" height="600" style="position:absolute;left:0;top:0"></canvas></div>');
    await page.evaluate(() => {
      const button = { uid: 4, name: 'Spin', eventMode: 'static', visible: true, children: [],
        getBounds: () => ({ x: 40, y: 30, width: 80, height: 40 }) };
      const stage = { visible: true, eventMode: 'passive', children: [button] };
      window.__PIXI_APP__ = { stage, canvas: document.querySelector('canvas'), renderer: { screen: { width: 800, height: 600 },
        events: { rootBoundary: { rootTarget: stage, hitTest: () => button } } } };
    });
    const result = await new ControlStateDetector({ frameBudgetMs: 500 }).observe(page);
    const control = result.controls.find((entry) => entry.source === 'pixi');
    assert.equal(control.enabled, false);
    assert.equal(control.interactable, false);
    assert.equal(control.availability, 'unavailable');
  });
});

test('Pixi observation never calls a hit-test method that mutates event scheduling', async () => {
  await withPage(async (page) => {
    await page.setContent('<canvas width="800" height="600" style="position:absolute;left:0;top:0"></canvas>');
    await page.evaluate(() => {
      window.hitTestCalls = 0;
      window.tickerState = { pauseUpdate: false };
      const button = { uid: 4, name: 'Spin', eventMode: 'static', visible: true, children: [],
        getBounds: () => ({ x: 40, y: 30, width: 80, height: 40 }) };
      const stage = { visible: true, eventMode: 'passive', children: [button] };
      window.__PIXI_APP__ = { stage, canvas: document.querySelector('canvas'), renderer: { screen: { width: 800, height: 600 },
        events: { rootBoundary: { rootTarget: stage, hitTest: () => {
          window.hitTestCalls++;
          window.tickerState.pauseUpdate = true;
          return button;
        } } } } };
    });
    const result = await new ControlStateDetector({ frameBudgetMs: 500 }).observe(page);
    assert.deepEqual(await page.evaluate(() => ({ calls: window.hitTestCalls, paused: window.tickerState.pauseUpdate })),
      { calls: 0, paused: false });
    const control = result.controls.find((entry) => entry.source === 'pixi');
    assert.equal(control.enabled, true);
    assert.equal(control.visible, true);
    assert.deepEqual(control.bounds, { x: 40, y: 30, width: 80, height: 40 });
    assert.equal(control.interactable, null);
    assert.equal(control.evidence.receivesInput, null);
    assert.equal(control.availability, 'unknown');
    const coverage = result.coverage.samples[1].frames[0].engines.find((entry) => entry.engine === 'pixi');
    assert.equal(coverage.publicHitTest, false);
    assert.equal(coverage.reason, 'hit-test-mutates-events-ticker');
  });
});
