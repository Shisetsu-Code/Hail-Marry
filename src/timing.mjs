import { setTimeout as sleep } from 'node:timers/promises';
export const delay = (ms, signal) => sleep(ms, undefined, { signal });

export async function mapConcurrent(items, limit, run) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Concurrency must be an integer from 1 to 8');
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = { status: 'fulfilled', value: await run(items[i], i) }; }
      catch (error) { results[i] = { status: 'rejected', reason: String(error?.stack || error) }; }
    }
  }));
  return results;
}
