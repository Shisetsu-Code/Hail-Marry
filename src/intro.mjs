const clean = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const forbidden = /\b(buy|purchase|deposit|withdraw|wager|gamble|comprar|compra|depositar|apostar|spin|girar)\b/;
const explicit = /\b(click|tap|press|touch|clic|pulsa|pulse|toca|toque|presiona|presione)\b.{0,30}\b(continue|start|begin|anywhere|continuar|comenzar|empezar|pantalla)\b/;
const short = /^(continue|continuar)$/;
const boundsOkay = b => b && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k])) && b.width > 0 && b.height > 0;

export function introCandidates(state) {
  const candidates = [];
  for (const control of state.controls ?? []) {
    const text = String(control.label || control.text || control.name || '');
    const normalized = clean(text);
    if (control.availability !== 'available' || !control.stable || !boundsOkay(control.bounds) || forbidden.test(normalized)) continue;
    if (explicit.test(normalized) || short.test(normalized)) candidates.push({ id: control.id, text, kind: 'control', bounds: control.bounds });
  }
  for (const line of state.ocr?.lines ?? []) {
    const normalized = clean(line.text);
    const agreedShort = short.test(normalized) && new Set(line.readings ?? []).size >= 2;
    if (line.confidence < 65 || !boundsOkay(line.bounds) || forbidden.test(normalized) || !(explicit.test(normalized) || agreedShort)) continue;
    if (!candidates.some(c => clean(c.text) === normalized)) candidates.push({ id: 'ocr:' + normalized, text: line.text, kind: 'ocr', bounds: line.bounds });
  }
  return candidates.slice(0, 8);
}

export function sameCandidate(before, now, tolerancePx = 12) {
  return Boolean(before && now && before.id === now.id && clean(before.text) === clean(now.text) &&
    boundsOkay(before.bounds) && boundsOkay(now.bounds) &&
    ['x', 'y', 'width', 'height'].every(key => Math.abs(before.bounds[key] - now.bounds[key]) <= tolerancePx));
}

export function validateDecision(decision, candidates, minConfidence = .80) {
  if (!decision || decision.status !== 'ok' || decision.inference !== true || decision.confidence < minConfidence ||
      !Number.isFinite(decision.confidence) || !['continue', 'dismiss'].includes(decision.action)) return null;
  return candidates.find(c => c.id === decision.candidateId) ?? null;
}
