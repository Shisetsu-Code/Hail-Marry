import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const preprocessScript = fileURLToPath(new URL('../python/ocr_preprocess.py', import.meta.url));

export function parseTsv(tsv) {
  const groups = new Map();
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5' || !Number.isFinite(Number(c[10])) || Number(c[10]) < 35 || !c.slice(11).join('\t').trim()) continue;
    const [x, y, width, height] = c.slice(6, 10).map(Number);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const key = c.slice(1, 5).join(':');
    const words = groups.get(key) ?? [];
    words.push({ text: c.slice(11).join('\t').trim(), confidence: Number(c[10]), x, y, width, height });
    groups.set(key, words);
  }
  return { lines: [...groups.values()].map(words => {
    const x = Math.min(...words.map(w => w.x));
    const y = Math.min(...words.map(w => w.y));
    return {
      text: words.map(w => w.text).join(' '),
      confidence: words.reduce((sum, w) => sum + w.confidence, 0) / words.length,
      bounds: { x, y, width: Math.max(...words.map(w => w.x + w.width)) - x, height: Math.max(...words.map(w => w.y + w.height)) - y },
    };
  }) };
}

// OCR sometimes reads a decorative border as a separate leading/trailing bar.
// Preserve meaningful signs (+/-), words and internal punctuation when merging.
const sameText = text => String(text).normalize('NFKC').toLowerCase().trim()
  .replace(/^[|¦]+\s+|\s+[|¦]+$/gu, '').replace(/\s+/g, ' ').trim();
const nearBounds = (a, b) => ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) <= 12);

export async function readScreenshotText(path, { signal, timeoutMs = 12000, languages = 'eng' } = {}) {
  const started = performance.now();
  const deadline = started + Math.max(0, Number(timeoutMs) || 0);
  const lines = [], passes = [];
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  const budget = slots => Math.max(1, Math.floor(remaining() / slots));
  const processOptions = timeout => ({ signal, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    // Pages already supply concurrency; avoid OpenMP worker fan-out.
    env: { ...process.env, OMP_THREAD_LIMIT: '1' } });

  async function readPass({ name, imagePath, psm, scaleX = 1, scaleY = 1 }, slots) {
    signal?.throwIfAborted();
    if (remaining() <= 0) {
      passes.push({ name, psm, status: 'skipped', reason: 'time_budget_exhausted' });
      return;
    }
    const passStarted = performance.now();
    try {
      const { stdout } = await run(process.env.TESSERACT_BIN || 'tesseract',
        [imagePath, 'stdout', '-l', languages, '--psm', String(psm), 'tsv'], processOptions(budget(slots)));
      const parsed = parseTsv(stdout);
      passes.push({ name, psm, status: 'ok', lines: parsed.lines.length, scaleX, scaleY,
        elapsedMs: Math.round(performance.now() - passStarted) });
      for (const raw of parsed.lines) {
        const line = { ...raw, bounds: { x: raw.bounds.x / scaleX, y: raw.bounds.y / scaleY,
          width: raw.bounds.width / scaleX, height: raw.bounds.height / scaleY }, readings: [name] };
        const duplicate = lines.findIndex(other => sameText(other.text) === sameText(line.text) && nearBounds(other.bounds, line.bounds));
        if (duplicate < 0) lines.push(line);
        else {
          const previous = lines[duplicate];
          const readings = [...new Set([...previous.readings, name])];
          lines[duplicate] = { ...(line.confidence > previous.confidence ? line : previous), readings };
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      passes.push({ name, psm, status: 'error', error: String(error.message).slice(0, 500),
        elapsedMs: Math.round(performance.now() - passStarted) });
    }
  }

  // Four OCR reads plus preprocessing share one deadline. Reserve time for the
  // later reads instead of allowing the first segmentation mode to consume it.
  await readPass({ name: 'original-psm11', imagePath: path, psm: 11 }, 5);
  await readPass({ name: 'original-psm6', imagePath: path, psm: 6 }, 4);
  let preprocessing = { status: 'skipped', reason: 'time_budget_exhausted' };
  signal?.throwIfAborted();
  if (remaining() > 0) {
    const preprocessingStarted = performance.now();
    try {
      const python = process.env.OCR_PYTHON || process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
      const { stdout } = await run(python, [preprocessScript, path], processOptions(Math.min(3000, budget(3))));
      const data = JSON.parse(stdout);
      if (data.status !== 'ok' || !Array.isArray(data.variants) || data.variants.length !== 2 ||
          !data.variants.every(v => ['rb', 'gb'].includes(v.name) && typeof v.path === 'string' &&
            Number.isFinite(v.scaleX) && v.scaleX > 0 && Number.isFinite(v.scaleY) && v.scaleY > 0)) {
        throw new Error('Invalid OCR preprocessing result');
      }
      preprocessing = { ...data, elapsedMs: Math.round(performance.now() - preprocessingStarted) };
      for (let i = 0; i < data.variants.length; i++) {
        const variant = data.variants[i];
        await readPass({ name: variant.name + '-psm11', imagePath: variant.path, psm: 11,
          scaleX: variant.scaleX, scaleY: variant.scaleY }, data.variants.length - i);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      preprocessing = { status: 'error', error: String(error.message).slice(0, 500),
        elapsedMs: Math.round(performance.now() - preprocessingStarted) };
    }
  }
  const okay = passes.some(pass => pass.status === 'ok');
  return { lines, status: okay ? 'ok' : 'error', source: 'tesseract', passes, preprocessing,
    ...(okay ? {} : { error: passes.map(p => p.error).filter(Boolean).join('; ') || 'OCR time budget exhausted' }),
    elapsedMs: Math.round(performance.now() - started) };
}
