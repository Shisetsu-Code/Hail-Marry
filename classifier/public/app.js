const $ = (id) => document.getElementById(id);
const modes = {
  spin: ['1', 'Spin', 'Haz clic en Spin para guardar su referencia. No se ejecutará.'],
  antebet: ['2', 'Antebet', 'Marca el activador: se activará y después se comprobará el Spin guardado.'],
  menu: ['3', 'Menú de compra', 'Haz clic en un menú de compra. Puedes marcar varios menús y submenús.'],
  buy: ['4', 'Compra directa', 'Haz clic en el control de compra directa.'],
  spin_only: ['5', 'Solo Spin', 'Haz clic en el único Spin: se guardará y finalizará el juego sin ejecutarlo.'],
  continue: ['Q', 'Continuar', 'Haz clic en Continuar para ejecutarlo y capturar la siguiente pantalla.'],
  option: ['+', 'Opción', 'Haz clic en una opción de esta pantalla.'],
  confirm: ['✓', 'Confirmar', 'Haz clic en el control de confirmación.'],
  cancel: ['×', 'Cancelar', 'Haz clic en el control de cancelación.'],
  back: ['←', 'Volver', 'Haz clic en el control para volver.'],
  bet: ['±', 'Apuesta', 'Haz clic en el control de apuesta.'],
};
const hotkeys = { '1': 'spin', '2': 'antebet', '3': 'menu', '4': 'buy', '5': 'spin_only', q: 'continue' };
let key = sessionStorage.getItem('guidedClassifierKey') || '';
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('key')) {
  key = fragment.get('key') || '';
  if (key) sessionStorage.setItem('guidedClassifierKey', key);
  history.replaceState(null, '', location.pathname + location.search);
}
let state = { games: [] }, selectedId = null, mode = 'spin', inspectedId = '', mutation = false;
let pollTimer, polling = false, stopped = false, imageGeneration = 0, imageKey = '', loadedImageKey = '', mutationEpoch = 0;
let imageAbort, activeImageUrl = '', noticeTimer;
const pending = new Map();
const game = () => state.games.find((item) => item.id === selectedId);
const shownScreen = () => {
  const g = game();
  return inspectedId ? g?.screens?.find((s) => s.id === inspectedId) : g?.screen;
};
const screenKey = (g, s) => g && s ? `${g.id}:${s.sessionId}:${s.id}:${s.revision}:${s.imageSha256}` : '';
const isCurrent = () => !!game()?.screen && shownScreen()?.id === game().screen.id;
const locked = () => mutation || !!game()?.busy || pending.has(selectedId);
const canMutate = () => !!game() && !!shownScreen() && isCurrent() && !locked() && loadedImageKey === screenKey(game(), shownScreen()) && !game().finished;

function notice(message, success = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').classList.toggle('success', success);
  $('notice').hidden = !message;
  if (success) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
}
function showAuth(message = '') {
  stopped = true;
  clearTimeout(pollTimer);
  $('auth-panel').hidden = false;
  $('workspace').hidden = true;
  $('auth-error').textContent = message;
  $('export').disabled = true;
  $('connection').textContent = 'Acceso privado';
  $('connection-dot').classList.add('offline');
  loadedImageKey = '';
  imageAbort?.abort();
  $('access-key').focus();
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: { ...options.headers, Authorization: `Bearer ${key}` },
  });
  if (response.status === 401 || response.status === 403) {
    showAuth('La clave no es válida o ha caducado.');
    throw new Error('Acceso no autorizado.');
  }
  if (!response.ok) {
    let message = `No se pudo completar la solicitud (${response.status}).`;
    try { const body = await response.json(); message = typeof body.error === 'string' ? body.error : body.error?.message || body.message || message; } catch {}
    throw new Error(message);
  }
  return response;
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function statusLabel(g) {
  if (g.busy || pending.has(g.id)) return 'Procesando…';
  if (g.error) return 'Revisar error';
  if (g.finished) return 'Finalizado';
  if (!g.screen) return 'Cargando…';
  return 'Listo para capturar';
}
function renderQueue() {
  const list = $('game-list');
  list.replaceChildren();
  for (const g of state.games) {
    const button = element('button', `game-item${g.id === selectedId ? ' active' : ''}`);
    button.dataset.gameId = g.id;
    button.setAttribute('aria-pressed', String(g.id === selectedId));
    button.append(element('strong', '', g.title || g.id), element('span', 'game-provider', g.provider || 'Juego'));
    button.append(element('span', `game-status${g.finished ? ' finished' : ''}`, `${g.finished ? '✓ ' : ''}${statusLabel(g)}`));
    button.addEventListener('click', () => { if (selectedId !== g.id) { selectedId = g.id; inspectedId = ''; notice(''); render(); } });
    list.append(button);
  }
  $('game-count').textContent = state.games.length;
  $('progress').textContent = `${state.games.filter((g) => g.finished).length} / ${state.games.length} finalizados`;
}
function renderModes() {
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.classList.toggle('selected', button.dataset.mode === mode);
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    button.disabled = mutation;
  }
  const [shortcut, , description] = modes[mode];
  $('mode-indicator').textContent = shortcut;
  $('instruction').textContent = !isCurrent() && shownScreen() ? 'Revisando una captura anterior. Vuelve a la pantalla actual para marcar.' : description;
  if ($('mark-only').checked && !['spin', 'spin_only'].includes(mode)) $('instruction').textContent += ' Solo se guardará la marca.';
}
function renderControls() {
  const g = game(), container = $('controls');
  const controls = g?.controls || [];
  container.replaceChildren();
  $('control-count').textContent = controls.length;
  if (!controls.length) container.append(element('p', 'empty', 'Los controles marcados aparecerán aquí.'));
  controls.forEach((control, index) => {
    const card = element('div', 'control-card');
    card.dataset.controlId = control.id;
    const title = element('div', 'control-title');
    title.append(element('span', 'control-number', index + 1), element('span', '', control.label || modes[control.mode]?.[1] || control.role || 'Control'));
    const routeScreen = g.screens?.find((s) => s.id === control.screenId);
    card.append(title, element('div', 'control-meta', `${modes[control.mode]?.[1] || control.mode} · ${control.executed ? 'Entrada enviada' : 'Sin ejecutar'}${control.screenId === g.screen?.id ? ' · Actual' : ` · ${routeScreen ? 'Captura guardada' : 'Otra captura'}`}`));
    const buttons = element('div', 'control-buttons');
    const inspect = element('button', '', 'Ver');
    inspect.disabled = !g.screens?.some((s) => s.id === control.screenId) && control.screenId !== g.screen?.id;
    inspect.addEventListener('click', () => { inspectedId = control.screenId === g.screen?.id ? '' : control.screenId; render(); });
    buttons.append(inspect);
    if (!control.executed) {
      const execute = element('button', 'execute-control', 'Ejecutar');
      execute.disabled = !canMutate() || control.screenId !== g.screen?.id || control.sessionId !== g.screen?.sessionId || control.mode === 'spin_only';
      execute.addEventListener('click', () => mutate('action', { controlId: control.id }));
      const remove = element('button', 'delete-control', 'Eliminar');
      remove.disabled = !canMutate() || controls.some((c) => c.spinControlId === control.id) || (g.actions || []).some((a) => a.controlId === control.id) || (g.screens || []).some((s) => s.viaControlId === control.id || s.route?.includes(control.id));
      remove.addEventListener('click', () => mutate(`controls/${encodeURIComponent(control.id)}`, {}, 'DELETE'));
      buttons.append(execute, remove);
    }
    card.append(buttons);
    container.append(card);
  });
}
function renderHistory() {
  const g = game(), select = $('history');
  select.replaceChildren(element('option', '', 'Pantalla actual'));
  select.firstChild.value = '';
  for (const [i, screen] of (g?.screens || []).entries()) {
    if (screen.id === g.screen?.id) continue;
    const option = element('option', '', `Captura ${i + 1} · ${screen.route?.length ? `${screen.route.length} pasos` : 'Inicio'}`);
    option.value = screen.id;
    select.append(option);
  }
  select.value = inspectedId;
  $('history-note').textContent = inspectedId ? 'Vista de una captura anterior. Las marcas están desactivadas.' : 'Puedes revisar las rutas anteriores.';
  const actions = $('actions');
  actions.replaceChildren();
  const rows = g?.actions || [];
  $('action-count').textContent = rows.length;
  if (!rows.length) actions.append(element('p', 'empty', 'Todavía no hay acciones.'));
  for (const action of [...rows].reverse()) {
    const control = g.controls?.find((c) => c.id === action.controlId);
    const row = element('div', 'action-row');
    row.append(element('strong', '', control?.label || modes[control?.mode || action.mode]?.[1] || action.type || 'Acción'));
    const status = action.confirmation?.status || action.status || 'pendiente';
    const labels = { pending: 'Pendiente de revisar', dispatched: 'Entrada enviada', confirmed: 'Efecto confirmado', unknown: 'Resultado pendiente', failed: 'Error', processing: 'Procesando', completed: 'Procesada', rejected: 'Rechazada' };
    row.append(element('small', '', labels[status] || status));
    if (action.error || action.confirmation?.reason) row.append(element('span', '', action.error?.message || action.error || action.confirmation.reason));
    actions.append(row);
  }
}
function renderMarkers() {
  const g = game(), screen = shownScreen();
  $('markers').replaceChildren();
  for (const [i, control] of (g?.controls || []).entries()) {
    if (control.screenId !== screen?.id) continue;
    const marker = element('span', `marker${control.executed ? ' executed' : ''}`, i + 1);
    marker.style.left = `${control.x * 100}%`;
    marker.style.top = `${control.y * 100}%`;
    $('markers').append(marker);
  }
}
async function loadImage(g, screen) {
  const nextKey = screenKey(g, screen);
  if (nextKey === imageKey) return;
  imageKey = nextKey;
  loadedImageKey = '';
  const generation = ++imageGeneration;
  imageAbort?.abort();
  imageAbort = new AbortController();
  $('image-wrap').hidden = true;
  $('stage-message').hidden = false;
  $('stage-message').textContent = screen ? 'Cargando captura…' : (g?.error?.message || g?.error || 'Esperando una captura…');
  if (!screen) return;
  try {
    const url = new URL(screen.imageUrl, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/images/')) throw new Error('La captura no tiene una dirección válida.');
    const response = await request(url.pathname + url.search, { signal: imageAbort.signal });
    const blob = await response.blob();
    if (generation !== imageGeneration || stopped) return;
    const objectUrl = URL.createObjectURL(blob);
    const img = $('screenshot');
    const previousUrl = activeImageUrl;
    activeImageUrl = objectUrl;
    img.src = objectUrl;
    try { await img.decode(); } catch { URL.revokeObjectURL(objectUrl); throw new Error('No se pudo leer la imagen de esta captura.'); }
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    if (generation !== imageGeneration || stopped) return;
    loadedImageKey = nextKey;
    $('stage-message').hidden = true;
    $('image-wrap').hidden = false;
    renderMarkers();
    renderControls();
    updateButtons();
  } catch (error) {
    if (generation !== imageGeneration || error.name === 'AbortError' || stopped) return;
    $('stage-message').textContent = error.message;
    notice(`Captura no disponible: ${error.message}`);
    updateButtons();
  }
}
function updateButtons() {
  $('refresh').disabled = !game() || !shownScreen() || !isCurrent() || locked() || game().finished;
  $('finish').disabled = !canMutate();
  $('mark-only').disabled = mutation;
}
function render() {
  renderQueue();
  const g = game(), screen = shownScreen();
  $('game-title').textContent = g?.title || 'Esperando juegos';
  $('provider').textContent = g?.provider || 'CAPTURA GUIADA';
  $('screen-meta').textContent = screen ? `${screen.width} × ${screen.height}` : '';
  const route = screen?.route || [];
  const names = route.map((id) => { const c = g.controls?.find((item) => item.id === id); return c?.label || modes[c?.mode]?.[1] || 'Control'; });
  $('route').textContent = names.length ? `Ruta: ${names.join(' › ')}` : 'Pantalla inicial';
  $('save-state').textContent = locked() ? 'Procesando · espera la siguiente captura…' : g?.finished ? 'Captura finalizada' : 'Listo';
  $('image-wrap').classList.toggle('inspect', !isCurrent() || !!g?.finished);
  renderModes();
  renderHistory();
  loadImage(g, screen);
  renderMarkers();
  renderControls();
  updateButtons();
}
function acceptState(next) {
  state = next;
  if (!state.games.some((g) => g.id === selectedId)) { selectedId = state.games.find((g) => !g.finished)?.id || state.games[0]?.id || null; inspectedId = ''; }
  for (const g of state.games) {
    const waiting = pending.get(g.id);
    if (!waiting) continue;
    if (g.busy) waiting.seenBusy = true;
    else if (waiting.seenBusy || JSON.stringify(g) !== waiting.before) {
      pending.delete(g.id);
      if (waiting.finishNext && g.finished && selectedId === g.id) selectNext(g.id);
    }
  }
  render();
  if (state.persistence?.error || ['failed', 'error'].includes(state.persistence?.status)) notice(`Envío a almacenamiento pendiente: ${state.persistence.error?.message || state.persistence.error || 'no se pudo guardar el progreso'}.`);
  else if (game()?.error) notice(game().error?.message || game().error);
}
async function poll() {
  if (stopped || polling) return;
  polling = true;
  const epoch = mutationEpoch;
  try {
    const response = await request('/api/state');
    const next = await response.json();
    if (stopped || mutation || epoch !== mutationEpoch) return;
    acceptState(next);
    $('connection').textContent = 'Sesión conectada';
    $('connection-dot').classList.remove('offline');
    $('export').disabled = false;
  } catch (error) {
    if (!stopped) { $('connection').textContent = 'Sin conexión · reintentando'; $('connection-dot').classList.add('offline'); notice(error.message); }
  } finally {
    polling = false;
    if (!stopped) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, mutation || pending.size || state.games.some((g) => g.busy) ? 500 : 1200); }
  }
}
function identity(screen) { return { screenId: screen.id, revision: screen.revision, imageSha256: screen.imageSha256 }; }
async function mutate(endpoint, data = {}, method = 'POST') {
  if (!canMutate()) return;
  const g = game(), screen = shownScreen();
  const finishNext = endpoint === 'finish' || (endpoint === 'mark' && data.mode === 'spin_only');
  mutation = true;
  mutationEpoch++;
  notice('');
  render();
  try {
    const response = await request(`/api/games/${encodeURIComponent(g.id)}/${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), ...identity(screen), ...data }),
    });
    const raw = await response.text();
    const body = raw ? JSON.parse(raw) : {};
    if (response.status === 202) pending.set(g.id, { before: JSON.stringify(g), seenBusy: !!body.game?.busy, finishNext });
    if (body.game) {
      const index = state.games.findIndex((item) => item.id === g.id);
      state.games[index] = body.game;
      if (response.status !== 202 && !body.game.busy) pending.delete(g.id);
      if (body.game.busy) pending.set(g.id, { before: JSON.stringify(g), seenBusy: true, finishNext });
    }
    if (finishNext && body.game?.finished) selectNext(g.id);
    if (endpoint === 'mark') $('mark-label').value = '';
    if (response.status !== 202 && !body.game?.busy) notice(endpoint.startsWith('controls/') ? 'Marca eliminada.' : finishNext ? 'Captura del juego finalizada.' : data.execute === false ? 'Referencia guardada sin ejecutar.' : 'Acción registrada. Revisa la captura y su historial.', true);
    clearTimeout(pollTimer);
  } catch (error) { notice(error.message); }
  finally { mutation = false; render(); if (!stopped) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 100); } }
}
function selectNext(previousId) {
  const index = state.games.findIndex((g) => g.id === previousId);
  const ordered = [...state.games.slice(index + 1), ...state.games.slice(0, index)];
  const next = ordered.find((g) => !g.finished);
  if (next) { selectedId = next.id; inspectedId = ''; }
}
function chooseMode(nextMode) {
  if (mutation || !modes[nextMode]) return;
  mode = nextMode;
  renderModes();
  if (mode === 'antebet' && !game()?.spinControlId && !game()?.controls?.some((c) => c.mode === 'spin')) notice('Primero marca el Spin normal con la tecla 1.');
  else notice('');
}
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => chooseMode(button.dataset.mode)));
document.addEventListener('keydown', (event) => {
  if (stopped || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (target instanceof Element && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
  const next = hotkeys[event.key.toLowerCase()];
  if (next) { event.preventDefault(); chooseMode(next); }
});
$('screenshot').addEventListener('click', (event) => {
  if (event.detail > 1 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !canMutate()) return;
  const g = game();
  if (mode === 'antebet' && !g.spinControlId && !g.controls?.some((c) => c.mode === 'spin')) { notice('Primero marca el Spin normal con la tecla 1.'); return; }
  if (mode === 'spin_only' && g.controls?.some((c) => ['antebet', 'menu', 'buy', 'option', 'confirm'].includes(c.mode))) { notice('Este juego ya tiene marcas de compra o Antebet. Usa Finalizar para conservar esas rutas.'); return; }
  const rect = $('screenshot').getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
  if (x < 0 || x >= 1 || y < 0 || y >= 1) return;
  mutate('mark', { mode, x, y, label: $('mark-label').value.trim() || undefined, execute: ['spin', 'spin_only'].includes(mode) ? false : !$('mark-only').checked });
});
$('mark-only').addEventListener('change', renderModes);
$('history').addEventListener('change', () => { inspectedId = $('history').value; notice(''); render(); });
$('refresh').addEventListener('click', () => { if (loadedImageKey !== imageKey && !locked()) { imageKey = ''; render(); } else mutate('refresh'); });
$('finish').addEventListener('click', () => mutate('finish'));
$('export').addEventListener('click', async () => {
  if ($('export').disabled) return;
  $('export').disabled = true;
  try {
    const response = await request('/api/export');
    const blob = await response.blob(), url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = `hail-marry-${String(state.runId || 'captura').replace(/[^a-z0-9_-]/gi, '_')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notice(error.message); }
  finally { $('export').disabled = stopped; }
});
$('auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  key = $('access-key').value.trim();
  if (!key) return;
  sessionStorage.setItem('guidedClassifierKey', key);
  $('access-key').value = '';
  stopped = false;
  $('auth-panel').hidden = true;
  $('workspace').hidden = false;
  imageKey = '';
  poll();
});
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(pollTimer); imageAbort?.abort(); if (activeImageUrl) URL.revokeObjectURL(activeImageUrl); });
if (key) { $('workspace').hidden = false; poll(); } else showAuth();
