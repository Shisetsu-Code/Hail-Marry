import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export function parseTsv(tsv) {
  const groups = new Map();
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5' || Number(c[10]) < 35 || !c.slice(11).join('\t').trim()) continue;
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

export async function readScreenshotText(path, { signal, timeoutMs = 12000, languages = 'eng' } = {}) {
  const started = performance.now();
  try {
    const { stdout } = await run(process.env.TESSERACT_BIN || 'tesseract',
      [path, 'stdout', '-l', languages, '--psm', '11', 'tsv'],
      { signal, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return { ...parseTsv(stdout), status: 'ok', source: 'tesseract', elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { lines: [], status: 'error', source: 'tesseract', error: String(error.message).slice(0, 500), elapsedMs: Math.round(performance.now() - started) };
  }
}
