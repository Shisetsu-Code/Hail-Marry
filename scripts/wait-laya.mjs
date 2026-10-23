import { LayaClient } from '../src/laya-client.mjs';
import { delay } from '../src/timing.mjs';
const client = new LayaClient({ timeoutMs: 2000 });
const deadline = Date.now() + 600000;
let error;
while (Date.now() < deadline) {
  try {
    const health = await client.health();
    process.stdout.write(JSON.stringify(health) + '\n');
    process.exit(0);
  } catch (failure) { error = failure; }
  await delay(1000);
}
throw new Error('Laya did not become ready: ' + error?.message);
