/**
 * Serializable browser-side read-only probes. No input dispatch, event registration, focus,
 * game-state assignment, synthetic pointer, or Phaser hitTest (which writes input.localX/Y).
 * Public contracts: https://pixijs.com/8.x/guides/components/events
 * https://pixijs.download/v8.10.0/docs/events.EventBoundary.html#hitTest
 * https://docs.phaser.io/api-documentation/3.90.0/class/input-inputmanager#pointWithinHitArea
 * https://layaair2.ldc2.layabox.com/api/English/Core.Sprite.html
 * UHT is a private, best-effort adapter: its flags never prove input receipt.
 */
export function probeFrame(options = {}) {
  const maxControls = options.maxControls ?? 250;
  const maxNodes = options.maxNodes ?? 4_000;
  const maxDepth = options.maxDepth ?? 32;
  const deadline = performance.now() + (options.budgetMs ?? 100);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const controls = [];
  const coverage = { complete: true, nodesVisited: 0, engines: [], warnings: [] };
  const read = (object, key) => { try { return object?.[key]; } catch { return undefined; } };
  const attempt = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
  const trim = (value, max = 160) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const rect = (value) => value && [value.x, value.y, value.width, value.height].every(finite) ?
    { x: value.x, y: value.y, width: value.width, height: value.height } : null;
  const exhausted = () => {
    const reason = controls.length >= maxControls ? 'control-limit' : coverage.nodesVisited >= maxNodes ? 'node-limit' :
      performance.now() > deadline ? 'frame-time-budget' : null;
    if (reason && !coverage.warnings.includes(reason)) { coverage.warnings.push(reason); coverage.complete = false; }
    return Boolean(reason);
  };
  const parent = (element) => element.parentElement ?? element.getRootNode?.().host ?? null;
  const intersect = (a, b) => {
    if (!a || !b) return null;
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  };
  const onScreen = (bounds) => intersect(bounds, { x: 0, y: 0, ...viewport });
  const pointsFor = (bounds) => {
    const visible = onScreen(bounds);
    return !visible ? [] : [[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75]].map(([x, y]) => ({
      x: visible.x + visible.width * x, y: visible.y + visible.height * y,
    }));
  };
  const composedContains = (container, target) => {
    for (let node = target, depth = 0; node && depth < maxDepth; node = parent(node), depth++) if (node === container) return true;
    return false;
  };
  const hitAt = (point) => {
    let hit = document.elementFromPoint(point.x, point.y);
    for (let depth = 0; hit?.shadowRoot && depth < maxDepth; depth++) {
      const deeper = hit.shadowRoot.elementFromPoint?.(point.x, point.y);
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    return hit;
  };
  const hitsElement = (element, point) => composedContains(element, hitAt(point));
  const visualState = (element) => {
    let visible = true, inert = false, ariaDisabled = false, alpha = 1, depth = 0;
    for (let current = element; current && depth++ < maxDepth; current = parent(current)) {
      const style = getComputedStyle(current);
      alpha *= Number.parseFloat(style.opacity) || 0;
      if (current.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          style.contentVisibility === 'hidden' || alpha <= .01) visible = false;
      if (current.inert || current.hasAttribute('inert')) inert = true;
      if (current.getAttribute('aria-disabled') === 'true') ariaDisabled = true;
    }
    return { visible, inert, ariaDisabled, depthLimited: depth > maxDepth };
  };
  const cssPath = (element) => {
    const segments = [];
    let chain = [], current = element, depth = 0;
    while (current?.nodeType === 1 && depth++ < maxDepth) {
      const tag = current.localName;
      let index = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === tag) index++;
      }
      chain.unshift(`${CSS.escape(tag)}:nth-of-type(${index})`);
      if (current.parentElement) current = current.parentElement;
      else {
        segments.unshift(chain.join(' > ')); chain = [];
        current = current.getRootNode().host;
      }
    }
    if (chain.length) segments.unshift(chain.join(' > '));
    return { selector: segments.join(' >> '), complete: !current };
  };
  const labelFor = (element) => {
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/).slice(0, 5)
      .map((id) => trim(element.getRootNode().getElementById?.(id)?.textContent)).filter(Boolean).join(' ');
    return trim(element.getAttribute('aria-label')) || trim(labelledBy) || trim(element.getAttribute('title')) ||
      trim(element.labels?.[0]?.textContent) ||
      (element.localName === 'input' && /^(button|submit|reset)$/i.test(element.type) ? trim(element.value) : '') ||
      trim(element.textContent) || trim(element.getAttribute('name')) || element.localName;
  };
  const roles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'combobox', 'textbox', 'menuitem', 'tab', 'option']);
  const candidate = (element) => {
    const tag = element.localName, role = element.getAttribute('role');
    if (tag === 'input' && element.type === 'hidden') return false;
    const native = ['button', 'input', 'select', 'textarea', 'summary'].includes(tag) || (tag === 'a' && element.hasAttribute('href'));
    const declaredHandler = typeof element.onclick === 'function' || typeof element.onpointerdown === 'function' || typeof element.onmousedown === 'function';
    // The canvas event handler usually routes input to many distinct scene objects.
    if (tag === 'canvas') return false;
    return native || roles.has(role) || declaredHandler || element.isContentEditable || (element.hasAttribute('tabindex') && element.tabIndex >= 0);
  };
  const addDom = (element) => {
    const bounds = rect(element.getBoundingClientRect());
    const visual = visualState(element), path = cssPath(element);
    const visible = visual.visible && Boolean(onScreen(bounds));
    const disabled = element.matches(':disabled') || visual.inert || visual.ariaDisabled;
    const enabled = !disabled;
    const probePoints = pointsFor(bounds);
    const inputPoints = visible && enabled && getComputedStyle(element).pointerEvents !== 'none' ?
      probePoints.filter((point) => hitsElement(element, point)) : [];
    const receivesInput = inputPoints.length > 0;
    controls.push({ localId: path.selector, source: 'dom', selector: path.selector,
      role: element.getAttribute('role') || element.localName, label: labelFor(element),
      visible, enabled, interactable: visible && enabled && receivesInput,
      bounds, geometryReliable: path.complete && !visual.depthLimited, probePoints, inputPoints, hitPoint: inputPoints[0] ?? null,
      observedAt: new Date().toISOString(), evidence: { kind: 'dom-hit-test', receivesInput,
        declaredDisabled: disabled, focusableHint: element.tabIndex >= 0, readOnly: Boolean(element.readOnly),
        reason: !visible ? 'hidden-or-offscreen' : disabled ? 'disabled-or-inert' : receivesInput ? 'element-receives-pointer' : 'occluded-or-pointer-events-none' } });
  };

  const roots = [{ root: document, depth: 0 }];
  while (roots.length && !exhausted()) {
    const { root, depth } = roots.shift();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let element = walker.nextNode(); element && !exhausted(); element = walker.nextNode()) {
      coverage.nodesVisited++;
      if (element.shadowRoot) {
        if (depth < maxDepth) roots.push({ root: element.shadowRoot, depth: depth + 1 });
        else { coverage.complete = false; coverage.warnings.push('shadow-depth-limit'); }
      }
      if (candidate(element)) attempt(() => addDom(element));
    }
  }

  const globalValue = (name) => attempt(() => Object.getOwnPropertyDescriptor(globalThis, name)?.value);
  const surfaceFor = (canvas, width, height) => {
    if (!(canvas instanceof HTMLCanvasElement) || !(width > 0 && height > 0)) return null;
    const box = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
    const sx = canvas.offsetWidth ? box.width / canvas.offsetWidth : 1;
    const sy = canvas.offsetHeight ? box.height / canvas.offsetHeight : 1;
    const left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const top = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const right = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
    const bottom = parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
    let reliable = true;
    for (let node = canvas, depth = 0; node && depth++ < maxDepth; node = parent(node)) {
      const transform = getComputedStyle(node).transform;
      if (transform && transform !== 'none') {
        const matrix = attempt(() => new DOMMatrixReadOnly(transform));
        if (!matrix || !matrix.is2D || Math.abs(matrix.b) > .0001 || Math.abs(matrix.c) > .0001 || matrix.a <= 0 || matrix.d <= 0) reliable = false;
      }
    }
    const visual = visualState(canvas);
    return { canvas, width, height, x: box.x + left * sx, y: box.y + top * sy,
      sx: (canvas.offsetWidth - left - right) * sx / width, sy: (canvas.offsetHeight - top - bottom) * sy / height,
      visible: visual.visible, enabled: !visual.inert && !visual.ariaDisabled, reliable: reliable && !visual.depthLimited };
  };
  const projectRect = (bounds, surface) => bounds && surface ? {
    x: surface.x + bounds.x * surface.sx, y: surface.y + bounds.y * surface.sy,
    width: bounds.width * surface.sx, height: bounds.height * surface.sy,
  } : null;
  const engineRecord = (data, surface) => {
    const bounds = data.bounds, probePoints = pointsFor(bounds);
    const canvasPoints = surface ? probePoints.filter((point) => hitsElement(surface.canvas, point)) : [];
    const visible = data.visible === false || surface?.visible === false || (bounds && !onScreen(bounds)) ? false : data.visible;
    const enabled = surface?.enabled === false ? false : data.enabled;
    const blocked = visible === false || enabled === false || (surface && bounds && canvasPoints.length === 0);
    return { ...data, visible, enabled, geometryReliable: Boolean(bounds && surface?.reliable && data.geometryReliable !== false),
      probePoints, inputPoints: [], hitPoint: null, interactable: blocked ? false : null,
      observedAt: new Date().toISOString(), evidence: { kind: 'engine-flags', receivesInput: blocked ? false : null,
        reason: blocked ? 'hidden-disabled-or-canvas-occluded' : 'input-target-unverified', ...(data.evidence || {}) } };
  };
  const rawRoots = ['__PIXI_APP__', 'pixiApp', 'app', 'application', '__PHASER_GAME__', 'phaserGame', 'game']
    .map((name) => ({ name, value: globalValue(name) })).filter(({ value }) => value && typeof value === 'object');
  const dedupeRoots = new Set();

  // Pixi v7/v8: only the existing public root boundary may establish a target. We do not
  // construct or replace a boundary, update transforms, or call its event-dispatch methods.
  for (const { name, value: app } of rawRoots) {
    if (exhausted()) break;
    const stage = read(app, 'stage'), renderer = read(app, 'renderer');
    if (!stage || !renderer || dedupeRoots.has(stage)) continue;
    dedupeRoots.add(stage);
    const canvas = read(app, 'canvas') || read(app, 'view') || read(renderer, 'canvas') || read(renderer, 'view');
    const screen = read(renderer, 'screen') || read(app, 'screen');
    const surface = surfaceFor(canvas, read(screen, 'width'), read(screen, 'height'));
    const boundary = read(read(renderer, 'events'), 'rootBoundary');
    const usableBoundary = boundary && read(boundary, 'rootTarget') === stage && typeof read(boundary, 'hitTest') === 'function';
    coverage.engines.push({ engine: 'pixi', root: name, publicHitTest: Boolean(usableBoundary) });
    const queue = [{ node: stage, path: name, visible: true, enabled: true, depth: 0 }];
    const seen = new Set();
    while (queue.length && !exhausted()) {
      const item = queue.pop(), node = item.node;
      if (!node || seen.has(node)) continue;
      seen.add(node); coverage.nodesVisited++;
      const mode = read(node, 'eventMode');
      const visible = item.visible && read(node, 'visible') !== false && read(node, 'worldVisible') !== false &&
        read(node, 'renderable') !== false && read(node, 'alpha') !== 0 && read(node, 'worldAlpha') !== 0;
      const enabled = item.enabled && mode !== 'none' && read(node, 'enabled') !== false;
      const actionListener = ['pointerdown', 'pointerup', 'pointertap', 'click', 'tap', 'mousedown', 'touchstart']
        .some((event) => typeof read(node, `on${event}`) === 'function' ||
          (typeof read(node, 'listenerCount') === 'function' && attempt(() => node.listenerCount(event), 0) > 0));
      const inputMode = mode === 'static' || mode === 'dynamic' || read(node, 'interactive') === true;
      if (inputMode || actionListener || read(node, 'cursor') === 'pointer') {
        const world = typeof read(node, 'getBounds') === 'function' ? attempt(() => node.getBounds(true)) : null;
        const worldBounds = rect(world) || (world && rect({ x: world.minX, y: world.minY, width: world.maxX - world.minX, height: world.maxY - world.minY }));
        const record = engineRecord({ source: 'pixi', localId: `${name}:${read(node, 'uid') ?? item.path}`,
          role: 'scene-control', label: trim(read(node, 'label')) || trim(read(node, 'name')) || 'Pixi control',
          visible, enabled: enabled && inputMode, bounds: projectRect(worldBounds, surface) }, surface);
        if (record.visible && record.enabled && surface?.reliable && usableBoundary) {
          const inputPoints = record.probePoints.filter((point) => hitsElement(surface.canvas, point) &&
            attempt(() => boundary.hitTest((point.x - surface.x) / surface.sx, (point.y - surface.y) / surface.sy)) === node);
          record.inputPoints = inputPoints; record.hitPoint = inputPoints[0] ?? null;
          record.interactable = inputPoints.length > 0;
          record.evidence = { kind: 'pixi-public-hit-test', receivesInput: inputPoints.length > 0,
            reason: inputPoints.length ? 'public-event-target-match' : 'public-event-target-miss' };
        }
        controls.push(record);
      }
      const children = read(node, 'children');
      if (Array.isArray(children) && item.depth < maxDepth) {
        for (let index = Math.min(children.length, maxNodes - coverage.nodesVisited) - 1; index >= 0; index--) {
          queue.push({ node: children[index], path: `${item.path}/${index}`, depth: item.depth + 1,
            visible, enabled: enabled && read(node, 'interactiveChildren') !== false });
        }
      } else if (Array.isArray(children) && children.length) { coverage.complete = false; coverage.warnings.push('pixi-depth-limit'); }
    }
  }

  // Phaser's hitTest/pointWithinHitArea write local pointer coordinates. Only scene flags
  // and identity-camera geometry are inspected; interactive remains unknown when unblocked.
  for (const { name, value: game } of rawRoots) {
    if (exhausted()) break;
    const scenes = read(read(game, 'scene'), 'scenes');
    if (!Array.isArray(scenes) || dedupeRoots.has(game)) continue;
    dedupeRoots.add(game);
    const size = read(read(game, 'scale'), 'gameSize');
    const surface = surfaceFor(read(game, 'canvas'), read(size, 'width'), read(size, 'height'));
    coverage.engines.push({ engine: 'phaser', root: name, publicHitTest: false, reason: 'hit-test-writes-input-coordinates' });
    for (let si = 0; si < Math.min(scenes.length, 16) && !exhausted(); si++) {
      const scene = scenes[si], list = read(read(scene, 'children'), 'list');
      if (!Array.isArray(list)) continue;
      const settings = read(read(scene, 'sys'), 'settings');
      const sceneEnabled = read(settings, 'active') !== false && read(read(scene, 'input'), 'enabled') !== false && read(read(game, 'input'), 'enabled') !== false;
      const camera = read(read(scene, 'cameras'), 'main');
      const identityCamera = camera && !read(camera, 'rotation') && !read(camera, 'scrollX') && !read(camera, 'scrollY') &&
        (read(camera, 'zoom') === 1 || read(camera, 'zoom') == null) && !read(camera, 'x') && !read(camera, 'y');
      const queue = list.slice(0, maxNodes).map((node, i) => ({ node, path: `${si}/${i}`, depth: 0, visible: read(settings, 'visible') !== false }));
      const seen = new Set();
      while (queue.length && !exhausted()) {
        const item = queue.pop(), node = item.node;
        if (!node || seen.has(node)) continue;
        seen.add(node); coverage.nodesVisited++;
        const visible = item.visible && read(node, 'visible') !== false && read(node, 'alpha') !== 0;
        const input = read(node, 'input');
        if (input) {
          const bounds = identityCamera && typeof read(node, 'getBounds') === 'function' ? rect(attempt(() => node.getBounds())) : null;
          controls.push(engineRecord({ source: 'phaser', localId: `${name}:${item.path}`, role: 'scene-control',
            label: trim(read(node, 'name')) || trim(read(node, 'text')) || 'Phaser control', visible,
            enabled: sceneEnabled && read(input, 'enabled') !== false, bounds: projectRect(bounds, surface) }, surface));
        }
        const children = read(node, 'list');
        if (Array.isArray(children) && item.depth < maxDepth) {
          for (let i = Math.min(children.length, maxNodes - coverage.nodesVisited) - 1; i >= 0; i--) queue.push({
            node: children[i], path: `${item.path}/${i}`, visible, depth: item.depth + 1 });
        }
      }
    }
  }

  const laya = globalValue('Laya'), layaStage = read(laya, 'stage');
  if (layaStage && !exhausted()) {
    const canvases = document.querySelectorAll('canvas');
    const canvas = read(read(laya, 'Render'), 'canvas') || (canvases.length === 1 ? canvases[0] : null);
    const surface = surfaceFor(canvas, read(layaStage, 'width'), read(layaStage, 'height'));
    coverage.engines.push({ engine: 'laya', root: 'Laya.stage', publicHitTest: false, reason: 'topmost-input-target-unverified' });
    const queue = [{ node: layaStage, path: 'stage', depth: 0, visible: true, enabled: true }], seen = new Set();
    while (queue.length && !exhausted()) {
      const item = queue.pop(), node = item.node;
      if (!node || seen.has(node)) continue;
      seen.add(node); coverage.nodesVisited++;
      const visible = item.visible && read(node, 'visible') !== false && read(node, 'alpha') !== 0;
      const enabled = item.enabled && read(node, 'mouseEnabled') !== false && read(node, 'disabled') !== true;
      const handler = typeof read(node, 'hasListener') === 'function' && ['click', 'mousedown', 'mouseup'].some((type) => attempt(() => node.hasListener(type), false));
      if (handler || /Button$/i.test(read(read(node, 'constructor'), 'name') || '')) {
        let bounds = null;
        const local = typeof read(node, 'getSelfBounds') === 'function' ? rect(attempt(() => node.getSelfBounds())) : null;
        if (local && typeof read(node, 'localToGlobal') === 'function' && typeof read(laya, 'Point') === 'function') {
          const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => attempt(() =>
            node.localToGlobal(new laya.Point(local.x + local.width * x, local.y + local.height * y), true)));
          if (points.every((p) => p && finite(p.x) && finite(p.y))) {
            const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
            bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
          }
        }
        controls.push(engineRecord({ source: 'laya', localId: `stage:${read(node, 'id') ?? item.path}`, role: 'scene-control',
          label: trim(read(node, 'name')) || trim(read(node, 'label')) || trim(read(node, 'text')) || 'Laya control',
          textHints: [trim(read(node, 'label')), trim(read(node, 'text'))].filter(Boolean),
          visible, enabled, bounds: projectRect(bounds, surface) }, surface));
      }
      const count = read(node, 'numChildren');
      if (Number.isSafeInteger(count) && typeof read(node, 'getChildAt') === 'function' && item.depth < maxDepth) {
        for (let i = Math.min(count, maxNodes - coverage.nodesVisited) - 1; i >= 0; i--) queue.push({
          node: attempt(() => node.getChildAt(i)), path: `${item.path}/${i}`, depth: item.depth + 1, visible, enabled });
      }
    }
  }

  const runtime = globalValue('globalRuntime'), sceneRoots = read(runtime, 'sceneRoots');
  if (Array.isArray(sceneRoots) && !exhausted()) {
    coverage.engines.push({ engine: 'uht', root: 'globalRuntime.sceneRoots', publicHitTest: false,
      reason: 'private-scene-flags-only; recursive-runtime-queries-cannot-be-preempted' });
    const uhtRoots = sceneRoots.slice(0, 3), cameras = [], canvasList = document.querySelectorAll('canvas');
    const canvas = canvasList.length === 1 ? canvasList[0] : null, screen = globalValue('UHTScreen');
    const surface = surfaceFor(canvas, read(screen, 'width') || canvas?.width, read(screen, 'height') || canvas?.height);
    const query = (go, ctor, cap = 80) => {
      if (exhausted() || !ctor || typeof read(go, 'GetComponentsInChildren') !== 'function') return [];
      const items = attempt(() => go.GetComponentsInChildren(ctor, true), []);
      if (!Array.isArray(items)) return [];
      if (items.length > cap) { coverage.complete = false; coverage.warnings.push('uht-result-cap'); }
      return items.slice(0, cap);
    };
    for (const root of uhtRoots) cameras.push(...query(root, globalValue('Camera'), 8));
    cameras.sort((a, b) => (read(b, 'depth') || 0) - (read(a, 'depth') || 0));
    const seen = new Set();
    for (let ri = 0; ri < uhtRoots.length && !exhausted(); ri++) {
      for (const type of ['XTButton', 'CATButton', 'UIButton']) {
        for (const [index, button] of query(uhtRoots[ri], globalValue(type)).entries()) {
          if (exhausted()) break;
          if (seen.has(button)) continue;
          seen.add(button); coverage.nodesVisited++;
          const go = read(button, 'gameObject'), collider = read(go, 'collider');
          const active = read(go, 'activeInHierarchy');
          let visible = typeof active === 'boolean' ? active : null;
          let enabled = [read(button, 'enabled'), read(button, 'xtEnabled'), read(collider, 'enabled')].includes(false) ? false : collider ? true : null;
          let path = [], transform = read(go, 'transform'), depth = 0;
          while (transform && depth++ < Math.min(22, maxDepth)) {
            const object = read(transform, 'gameObject');
            path.unshift(trim(read(object, 'name'), 60));
            if (read(object, 'activeInHierarchy') === false) visible = false;
            transform = read(transform, 'parent');
          }
          const layer = read(go, 'layer');
          const camera = cameras.find((cam) => read(cam, 'enabled') !== false &&
            (!Number.isInteger(layer) || layer < 0 || layer > 31 || (read(cam, 'cullingMask') & (1 << layer)) !== 0));
          const colliderBounds = typeof read(collider, 'GetTransformedCenterAndSize') === 'function' ?
            attempt(() => collider.GetTransformedCenterAndSize()) : null;
          let bounds = null;
          if (camera && colliderBounds?.center && colliderBounds?.size && typeof read(camera, 'WorldToScreenPoint') === 'function') {
            const { center, size } = colliderBounds;
            const points = [[-.5, -.5], [.5, -.5], [-.5, .5], [.5, .5]].map(([x, y]) => attempt(() =>
              camera.WorldToScreenPoint({ x: center.x + size.x * x, y: center.y + size.y * y, z: center.z })));
            if (points.every((p) => p && finite(p.x) && finite(p.y))) {
              const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
              bounds = projectRect({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }, surface);
            }
          }
          // Names are identities. Nearby labels/sprites are retained separately: a stop button
          // may contain unrelated fruit artwork or a continue button a numeric win label.
          const textHints = query(go, globalValue('UILabel'), 12).filter((item) => read(read(item, 'gameObject'), 'activeInHierarchy') !== false)
            .map((item) => trim(read(item, 'text'), 90)).filter(Boolean);
          const spriteHints = query(go, globalValue('UISprite'), 12).filter((item) => read(read(item, 'gameObject'), 'activeInHierarchy') !== false)
            .map((item) => trim(read(item, 'spriteName'), 90)).filter(Boolean);
          controls.push(engineRecord({ source: 'uht', localId: `${ri}:${type}:${path.filter(Boolean).join('/') || index}`,
            role: 'scene-control', label: trim(read(go, 'name')) || type, textHints: [...new Set(textHints)], spriteHints: [...new Set(spriteHints)],
            visible, enabled, bounds }, surface));
        }
      }
    }
    if (sceneRoots.length > 3) { coverage.complete = false; coverage.warnings.push('uht-root-cap'); }
  }
  return { controls, viewport, coverage, observedAt: new Date().toISOString() };
}

/** Map child-frame CSS viewport coordinates through its content box and parent occlusion. */
export function projectThroughFrame(element, { controls, viewport }) {
  const parentViewport = { width: window.innerWidth, height: window.innerHeight };
  const box = element.getBoundingClientRect(), style = getComputedStyle(element);
  const scaleX = element.offsetWidth ? box.width / element.offsetWidth : 0;
  const scaleY = element.offsetHeight ? box.height / element.offsetHeight : 0;
  const left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  const top = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
  const right = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
  const bottom = parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
  const sx = (element.offsetWidth - left - right) * scaleX / viewport.width;
  const sy = (element.offsetHeight - top - bottom) * scaleY / viewport.height;
  const x = box.x + left * scaleX, y = box.y + top * scaleY;
  let reliable = [sx, sy, x, y].every(Number.isFinite) && sx > 0 && sy > 0;
  let visible = true, enabled = true, alpha = 1, depth = 0, current = element;
  const parent = (node) => node.parentElement ?? node.getRootNode?.().host ?? null;
  while (current && depth++ < 64) {
    const css = getComputedStyle(current);
    alpha *= parseFloat(css.opacity) || 0;
    if (current.hidden || css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || css.contentVisibility === 'hidden' || alpha <= .01) visible = false;
    if (current.inert || current.getAttribute('aria-disabled') === 'true') enabled = false;
    if (css.transform && css.transform !== 'none') {
      try {
        const matrix = new DOMMatrixReadOnly(css.transform);
        if (!matrix.is2D || Math.abs(matrix.b) > .0001 || Math.abs(matrix.c) > .0001 || matrix.a <= 0 || matrix.d <= 0) reliable = false;
      } catch { reliable = false; }
    }
    current = parent(current);
  }
  if (current) reliable = false;
  const project = (point) => ({ x: x + point.x * sx, y: y + point.y * sy });
  const receives = (point) => {
    if (point.x < 0 || point.y < 0 || point.x >= parentViewport.width || point.y >= parentViewport.height) return false;
    let hit = document.elementFromPoint(point.x, point.y);
    for (let depth = 0; hit?.shadowRoot && depth < 32; depth++) {
      const next = hit.shadowRoot.elementFromPoint?.(point.x, point.y);
      if (!next || next === hit) break;
      hit = next;
    }
    return hit === element;
  };
  const mapped = controls.map((control) => {
    const bounds = control.bounds && { x: x + control.bounds.x * sx, y: y + control.bounds.y * sy,
      width: control.bounds.width * sx, height: control.bounds.height * sy };
    const probePoints = (control.probePoints || []).map(project).filter(receives);
    const inputPoints = (control.inputPoints || []).map(project).filter(receives);
    const offscreen = bounds && (bounds.width <= 0 || bounds.height <= 0 || bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0 || bounds.x >= parentViewport.width || bounds.y >= parentViewport.height);
    const blocked = !visible || !enabled || offscreen || (control.probePoints?.length > 0 && probePoints.length === 0);
    return { ...control, bounds, probePoints, inputPoints, hitPoint: inputPoints[0] ?? null,
      visible: !visible || offscreen ? false : control.visible, enabled: !enabled ? false : control.enabled,
      geometryReliable: reliable && control.geometryReliable,
      interactable: blocked ? false : !reliable ? null : control.interactable,
      evidence: { ...control.evidence, receivesInput: blocked ? false : !reliable ? null :
        control.evidence.receivesInput === true ? inputPoints.length > 0 : control.evidence.receivesInput,
        frameGate: blocked ? 'frame-hidden-disabled-occluded-or-offscreen' : !reliable ? 'unsupported-frame-transform' : 'frame-hit-test-passed' } };
  });
  return { controls: mapped, viewport: parentViewport };
}
