import { createHash } from 'node:crypto';

export const ROUTE_KINDS = Object.freeze([
  'intro_continue', 'open_menu', 'bonus_entry', 'bonus_option', 'bet_adjust',
  'ante_toggle', 'purchase_confirm', 'close_back', 'spin', 'autoplay', 'other', 'unknown',
]);
const ACTIONABLE = new Set(['open_menu', 'bonus_entry', 'bonus_option', 'bet_adjust', 'ante_toggle']);
const PRIORITY = { bonus_entry: 0, bonus_option: 1, ante_toggle: 2, bet_adjust: 3, open_menu: 4 };
const DEMO_HOSTS = new Set(['demogamesfree.pragmaticplay.net','demo.bgaming-network.com','released.playngonetwork.com']);

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}+\-./\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function demoMode(url, { localFixture = false } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' && !(localFixture && parsed.protocol === 'http:')) return false;
  if (localFixture && parsed.protocol === 'http:' && ['127.0.0.1','localhost'].includes(parsed.hostname)) return true;
  if (!DEMO_HOSTS.has(parsed.hostname)) return false;
  if (parsed.hostname === 'demo.bgaming-network.com') return /\/FUN(?:\/|$)/i.test(parsed.pathname) || /server=demo/i.test(parsed.search);
  if (parsed.hostname === 'released.playngonetwork.com') return parsed.searchParams.get('practice') === '1' && parsed.searchParams.get('demo') === '2';
  return parsed.searchParams.get('jurisdiction') === '99' && parsed.pathname.endsWith('/openGame.do');
}

export function classifyHint(value) {
  const t = normalizeText(value);
  if (!t) return 'unknown';
  // UHT draws the free-spins purchase dialog as private scene controls named
  // Button_Yes and Button_No. Ancestors contain `BuyFeature`; that MUST NOT
  // classify these final-confirmation buttons as a fresh bonus entry.
  // The same guard applies to other engines and to GPT-suggested route labels.
  if (/\b(?:button|btn)\s+(?:yes|ok|accept|agree|confirm|si)\b/.test(t)) return 'purchase_confirm';
  if (/\b(?:button|btn)\s+(?:no|cancel|reject|decline)\b/.test(t)) return 'close_back';
  if (/(buy.?feature|bonus.?buy|buy.?bonus|purchase.?bonus|confirm\s+(?:buy|purchase))/.test(t) &&
      /\b(?:yes|accept|agree|confirm|si)\b/.test(t)) return 'purchase_confirm';
  if (/(buy.?feature|bonus.?buy|buy.?bonus|purchase.?bonus)/.test(t) &&
      /\b(?:no|cancel|decline|reject)\b/.test(t)) return 'close_back';
  if (/\b(confirm|confirmar|purchase now|pay now|comprar ahora|confirm purchase|confirm buy|accept purchase|aceptar compra|comprar por)\b/.test(t)) return 'purchase_confirm';
  if (/\b(spin|startspin|start spin|girar|tirar|tirada|jugar giro)\b/.test(t)) return 'spin';
  if (/\b(auto.?play|auto.?spin|autoplay)\b/.test(t)) return 'autoplay';
  if (/\b(close|back|cancel|cerrar|volver|atras|cancelar|escape|return)\b/.test(t)) return 'close_back';
  if (/(click|tap|press|touch|clic|pulsa|toca|presiona).{0,28}(continue|start|begin|anywhere|continuar|empezar)|\b(continue|continuar)\b/.test(t)) return 'intro_continue';
  if (/(ante\s*bet|antebet|extra\s*bet|double\s*chance|chance\s*x\s*2|feature\s*chance|apuesta\s*extra)/.test(t)) return 'ante_toggle';
  if (/(buy.?feature|feature.?buy|bonus.?buy|buy.?bonus|comprar.?bonus|comprar.?giros|purchase.?bonus|buy.?free.?spins|buyfeature)/.test(t)) return 'bonus_entry';
  if (/(free\s*spins|super\s*bonus|mega\s*bonus|bonus\s*round|bonus\s*game|feature\s*option|giros\s*gratis)/.test(t)) return 'bonus_option';
  if (/(bet\s*[+\-]|[+\-]\s*bet|bet\s*(up|down|increase|decrease)|betup|betdown|apuesta\s*[+\-]|cambiar\s*apuesta|change\s*bet|bet\s*size|bet\s*amount|bet\s*settings)/.test(t)) return 'bet_adjust';
  if (/^(menu|menus|settings|setting|options|opciones|ajustes|configuracion|features|feature|more features|mas opciones|buy menu|bet menu)$/.test(t)) return 'open_menu';
  if (/\b(deposit|withdraw|cashout|real money|money transfer|account balance)\b/.test(t)) return 'other';
  return 'unknown';
}

function boundsValid(b) { return b && ['x','y','width','height'].every(k => Number.isFinite(b[k])) && b.width > 2 && b.height > 2; }
function midpoint(bounds) { return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; }
function compactPath(localId) { return String(localId || '').replace(/^\d+:[^:]+:\d+:/, ''); }
function routeIdentity(item) {
  const normalized = normalizeText(item.text).slice(0, 110);
  const local = item.localPath && item.source !== 'ocr' ? compactPath(item.localPath).slice(-180) : '';
  const pt = item.normalizedPoint ?? { x: item.point.x / 1280, y: item.point.y / 720 };
  return `${item.kind}|${item.source}|${local}|${normalized}|${Math.round(pt.x*20)}:${Math.round(pt.y*20)}`;
}

export function discoverActions(state, { gptKinds = {}, allowEngine = true } = {}) {
  const result = [];
  const viewport = state.viewport || { width: 1280, height: 720 };
  for (const control of state.controls || []) {
    if (!control.stable || !boundsValid(control.bounds) || control.visible !== true || control.enabled !== true || control.geometryReliable !== true) continue;
    if (control.source === 'dom' && control.availability !== 'available') continue;
    if (control.source !== 'dom' && !allowEngine) continue;
    if (control.source !== 'dom' && control.availability === 'unavailable') continue;
    const hints = [control.label, ...(control.textHints || []), ...(control.spriteHints || []), control.localId].filter(Boolean);
    const humanLabel = String(control.label || control.textHints?.[0] || control.localId || '').trim();
    const hint = hints.join(' ');
    const proposed = gptKinds[control.id];
    const inferredKind = typeof proposed === 'string' ? proposed : proposed?.kind;
    const hintKind = classifyHint(humanLabel + ' ' + hint);
    const gptDriven = ROUTE_KINDS.includes(inferredKind) && (proposed?.confidence ?? 0) >= 0.8 && hintKind === 'unknown';
    // A model cannot relabel a spin, autoplay, payment confirmation or close control as a menu action.
    const protectedKind = ['spin', 'autoplay', 'purchase_confirm', 'close_back', 'intro_continue'].includes(hintKind);
    const classified = protectedKind ? hintKind : gptDriven ? inferredKind : hintKind;
    const point = control.hitPoint || midpoint(control.bounds);
    const candidate = {
      id: control.id, source: control.source, text: humanLabel, hint: hint.slice(0, 220),
      kind: classified, gptDriven, localPath: control.localId || null, availability: control.availability,
      bounds: control.bounds, point, normalizedPoint: { x: point.x / viewport.width, y: point.y / viewport.height },
      evidence: control.evidence?.kind || 'unverified', control,
    };
    candidate.routeKey = routeIdentity(candidate);
    result.push(candidate);
  }
  for (const line of state.ocr?.lines || []) {
    if (!boundsValid(line.bounds) || !Number.isFinite(line.confidence) || line.confidence < 75 || new Set(line.readings || []).size < 2) continue;
    const kind = classifyHint(line.text);
    if (kind === 'unknown' || kind === 'other') continue;
    const label = normalizeText(line.text);
    // An OCR line is not proof of a button. Only short, explicit control labels
    // qualify: never treat a heading such as "Buy Bonus options" as a click target.
    const labelLooksLikeControl = kind === 'intro_continue' ||
      (kind === 'bonus_entry' && /^(buy bonus|buy feature|bonus buy|buy free spins|comprar bonus|comprar giros)$/.test(label)) ||
      (kind === 'bonus_option' && /^(free spins|super bonus|mega bonus|bonus round|giros gratis)(?:\s+[\d.,]+)?(?:\s+fun)?$/.test(label)) ||
      (kind === 'ante_toggle' && /^(ante bet|antebet|extra bet|double chance|feature chance|apuesta extra)(?:\s+(on|off|[+\-]))?$/.test(label)) ||
      (kind === 'bet_adjust' && /^(bet\s*[+\-]|[+\-]\s*bet|bet up|bet down|betup|betdown|apuesta\s*[+\-])$/.test(label)) ||
      (kind === 'open_menu' && /^(menu|settings|options|features|opciones|ajustes|configuracion)$/.test(label));
    if (!labelLooksLikeControl) continue;
    const point = midpoint(line.bounds);
    if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || point.x >= viewport.width || point.y >= viewport.height) continue;
    const candidate = {
      id: 'ocr:' + normalizeText(line.text).slice(0, 90), source: 'ocr', text: line.text, hint: line.text,
      kind, localPath: null, availability: 'unknown', bounds: line.bounds, point,
      normalizedPoint: { x: point.x / viewport.width, y: point.y / viewport.height },
      evidence: 'ocr-multiple-readings', control: null,
    };
    candidate.routeKey = routeIdentity(candidate);
    // Prefer a matching actionable DOM or engine control when OCR lands in its bounds.
    const duplicate = result.some(c => c.kind === kind && c.source !== 'ocr' &&
      point.x >= c.bounds.x - 15 && point.x <= c.bounds.x + c.bounds.width + 15 &&
      point.y >= c.bounds.y - 15 && point.y <= c.bounds.y + c.bounds.height + 15);
    if (!duplicate) result.push(candidate);
  }
  const unique = [...new Map(result.map(c => [c.routeKey, c])).values()];
  return unique.sort((a, b) => (PRIORITY[a.kind] ?? 99) - (PRIORITY[b.kind] ?? 99) || a.routeKey.localeCompare(b.routeKey));
}

/** A purchase confirmation is a terminal BFS stage: reaching it establishes
 * entry into a purchase flow but NEVER licenses clicking its Yes/OK target.
 * The underlying game's controls can retain `enabled=true` beneath the modal.
 */
export function isPurchaseConfirmationState(candidates, ancestry = []) {
  return ancestry.some(edge => ['bonus_entry', 'bonus_option'].includes(edge.kind)) &&
    candidates.some(candidate => candidate.kind === 'purchase_confirm');
}

export function routeAllowed(candidate, { demo = false, initiateDemoPurchase = false, ancestry = [] } = {}) {
  if (!candidate || !ACTIONABLE.has(candidate.kind)) return false;
  if (!demo) return false;
  if (candidate.kind === 'bonus_option' && !initiateDemoPurchase) return false;
  if (candidate.kind === 'bet_adjust' && ancestry.some(edge => edge.kind === 'bet_adjust' && edge.routeKey === candidate.routeKey)) return false;
  if (candidate.kind === 'ante_toggle' && ancestry.some(edge => edge.kind === 'ante_toggle' && edge.routeKey === candidate.routeKey)) return false;
  // No route may reuse the same candidate: protects against toggle loops / menu-open loops.
  return !ancestry.some(edge => edge.routeKey === candidate.routeKey);
}

export function stateFingerprint(state) {
  const controls = (state.controls || []).filter(c => c.visible === true && c.stable === true)
    .map(c => [c.source, normalizeText(c.label || c.localId || '').replace(/\d+(?:[.,]\d+)?/g, '#'), c.enabled, c.localId?.split('/').slice(-2).join('/')]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const texts = (state.ocr?.lines || []).filter(c => c.confidence >= 65)
    .map(c => { const t = normalizeText(c.text); return /\b(bet|apuesta|ante bet|chance)\b/.test(t) ? t : t.replace(/\b\d+(?:[.,]\d+)?\b/g, '#'); }).filter(Boolean).sort().slice(0, 48);
  const content = JSON.stringify({ controls, texts });
  return createHash('sha256').update(content).digest('hex').slice(0, 24);
}

export function matchRoute(state, route, options = {}) {
  const candidates = discoverActions(state, options).filter(c => c.source === route.source);
  const compatible = c => c.kind === route.kind || (route.gptDriven && c.kind === 'unknown');
  const safe = c => { const blocked = ['spin', 'autoplay', 'purchase_confirm', 'close_back'].includes(classifyHint(c.text + ' ' + c.hint)); return !blocked && (route.kind === 'intro_continue' || classifyHint(c.text + ' ' + c.hint) !== 'intro_continue'); };
  const valid = candidates.filter(c => compatible(c) && safe(c));
  const byPath = route.localPath ? valid.filter(c => c.localPath === route.localPath && normalizeText(c.text) === normalizeText(route.text)) : [];
  if (byPath.length === 1) return { ...byPath[0], kind: route.kind, routeKey: route.routeKey };
  const byText = valid.filter(c => normalizeText(c.text) === normalizeText(route.text));
  if (byText.length === 1) return { ...byText[0], kind: route.kind, routeKey: route.routeKey };
  // Never guess when two same-labelled items exist after replay.
  return null;
}

export function screenPacket(state, candidates, path = []) {
  return {
    version: 1, fingerprint: stateFingerprint(state), screenshot: state.screenshot || null,
    at: state.screenshotAt || state.observedAt || new Date().toISOString(),
    text: (state.ocr?.lines || []).map(x => x.text).slice(0, 70).join('\n').slice(0, 4000),
    path: path.map(x => ({ kind: x.kind, text: x.text, routeKey: x.routeKey })),
    candidates: candidates.slice(0, 60).map(c => ({ id: c.id, kind: c.kind, text: c.text, hint: c.hint,
      source: c.source, availability: c.availability, point: c.normalizedPoint })),
    coverageComplete: state.coverage?.complete === true,
  };
}
