import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LayaClient, LayaClientError } from '../src/laya-client.mjs';

const model = {
  id: 'convaiinnovations/laya-multilingual',
  revision: '1720e3e3357cfe1e281542e223f8273b0890ca34',
};
const request = {
  text: 'Click to continue',
  candidates: [{ id: 'intro', text: 'Click to continue', kind: 'ocr', x: 0.5, y: 0.6 }],
};
const decision = {
  status: 'ok', action: 'continue', candidateId: 'intro', confidence: 0.94,
  inference: true, reason: 'intro_action', model,
};

async function server(t, handler) {
  const service = http.createServer(handler);
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(() => new Promise(resolve => {
    service.closeAllConnections();
    service.close(resolve);
  }));
  return `http://127.0.0.1:${service.address().port}`;
}

function reply(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

test('classifies OCR text and returns only a response bound to a submitted candidate', async t => {
  let received;
  const baseUrl = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, method: req.method, body: JSON.parse(Buffer.concat(chunks)) };
    reply(res, decision);
  });
  const result = await new LayaClient({ baseUrl }).classifyIntro(request);
  assert.equal(result.action, 'continue');
  assert.equal(result.candidateId, 'intro');
  assert.equal(result.inference, true);
  assert.deepEqual(received, {
    path: '/classify-intro', method: 'POST',
    body: { text: 'Click to continue', candidates: [{ id: 'intro', text: 'Click to continue', kind: 'ocr' }] },
  });
});

test('rejects actionable responses without real inference, valid confidence, or a known target', async t => {
  for (const invalid of [
    { ...decision, inference: false },
    { ...decision, confidence: 1.2 },
    { ...decision, confidence: 0.7 },
    { ...decision, candidateId: 'invented' },
    { ...decision, status: 'needs_review' },
    { ...decision, model: { ...model, revision: 'main' } },
  ]) {
    const baseUrl = await server(t, (_req, res) => reply(res, invalid));
    await assert.rejects(new LayaClient({ baseUrl }).classifyIntro(request),
      error => error instanceof LayaClientError && error.code === 'invalid_response');
  }
});

test('preserves an explicit no-inference abstention without pretending a model ran', async t => {
  const baseUrl = await server(t, (_req, res) => reply(res, {
    ...decision, status: 'needs_review', action: 'none', candidateId: null,
    confidence: 0, inference: false, reason: 'input_token_limit',
  }));
  const result = await new LayaClient({ baseUrl }).classifyIntro(request);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.inference, false);
  assert.equal(result.candidateId, null);
});

test('rejects an unavailable runtime instead of returning a fabricated classification', async t => {
  const baseUrl = await server(t, (_req, res) => reply(res, { error: 'not_ready' }, 503));
  await assert.rejects(new LayaClient({ baseUrl }).classifyIntro(request),
    error => error instanceof LayaClientError && error.code === 'http_error' && error.status === 503);
});

test('timeout also bounds a response whose body never finishes', async t => {
  const baseUrl = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  const started = Date.now();
  await assert.rejects(new LayaClient({ baseUrl, timeoutMs: 100 }).classifyIntro(request),
    error => error instanceof LayaClientError && error.code === 'timeout');
  assert.ok(Date.now() - started < 2000, 'the response body must share the request deadline');
});

test('ambiguous duplicate candidate IDs fail before any request is sent', async t => {
  let requests = 0;
  const baseUrl = await server(t, (_req, res) => { requests += 1; reply(res, decision); });
  await assert.rejects(new LayaClient({ baseUrl }).classifyIntro({
    ...request, candidates: [request.candidates[0], request.candidates[0]],
  }), error => error instanceof LayaClientError && error.code === 'invalid_input');
  assert.equal(requests, 0);
});

test('health requires the pinned ready model', async t => {
  const baseUrl = await server(t, (_req, res) => reply(res, {
    ready: true, model, runtime: { layaVersion: '0.4.14', device: 'cpu', threads: 2 },
  }));
  assert.equal((await new LayaClient({ baseUrl }).health()).ready, true);
});

test('sidecar uses answer probability and abstains when evidence is truncated or uncertain', () => {
  const script = `
import copy, importlib.util, json, sys
spec = importlib.util.spec_from_file_location('laya_sidecar', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = module.validate_payload({'text': 'Click to continue', 'candidates': [{'id': 'intro', 'text': 'Click to continue'}]})
raw = {'answers': {
 'intent': {'type': 'choice', 'choice': 'continue', 'probabilities': {'continue': .92, 'dismiss': .04, 'none': .04}, 'confidence': .4, 'answer_confidence': .92, 'action': {'act_probability': .1}},
 'target': {'type': 'choice', 'choice': 'control_0', 'probabilities': {'control_0': .95, 'no_control': .05}, 'confidence': .4, 'answer_confidence': .95, 'action': {'act_probability': .1}}
}, 'usage': {'input_tokens': 40, 'output_tokens': 0, 'truncated': False}}
fixtures = [raw]
low = copy.deepcopy(raw); low['answers']['target']['answer_confidence'] = .6; fixtures.append(low)
truncated = copy.deepcopy(raw); truncated['usage']['truncated'] = True; fixtures.append(truncated)
print(json.dumps([{key: result[key] for key in ['status', 'action', 'candidateId', 'reason', 'inference']} for result in [module.interpret_prediction(item, payload, .8) for item in fixtures]]))
`;
  const results = JSON.parse(execFileSync('python3', ['-c', script,
    fileURLToPath(new URL('../python/laya_server.py', import.meta.url))], { encoding: 'utf8' }));
  assert.deepEqual(results, [
    { status: 'ok', action: 'continue', candidateId: 'intro', reason: 'intro_action', inference: true },
    { status: 'needs_review', action: 'none', candidateId: null, reason: 'low_confidence', inference: true },
    { status: 'needs_review', action: 'none', candidateId: null, reason: 'truncated_input', inference: true },
  ]);
});

test('sidecar deadline terminates a stuck worker and marks the runtime unavailable', () => {
  const script = `
import importlib.util, json, multiprocessing, sys, threading, time
spec = importlib.util.spec_from_file_location('laya_sidecar', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
# The sleeping process substitutes only expensive model startup/inference.
# Real IPC, the deadline, process termination and readiness logic remain in use.
context = multiprocessing.get_context('spawn')
runtime = module.Runtime.__new__(module.Runtime)
runtime.settings = {'inference_timeout_seconds': .1}
runtime.lock = threading.Lock()
runtime.ready = True
runtime.connection, child = context.Pipe()
runtime.process = context.Process(target=time.sleep, args=(30,), daemon=True)
runtime.process.start()
try:
 try:
  runtime.predict({'text': 'Click to continue', 'candidates': []})
  raise AssertionError('Expected the inference deadline to fail')
 except module.RuntimeFailure as error:
  print(json.dumps({'code': error.code, 'status': error.status, 'ready': runtime.ready, 'alive': runtime.process.is_alive()}))
finally:
 runtime.close()
 child.close()
`;
  const result = JSON.parse(execFileSync('python3', ['-c', script,
    fileURLToPath(new URL('../python/laya_server.py', import.meta.url))], { encoding: 'utf8', timeout: 5000 }));
  assert.deepEqual(result, { code: 'inference_timeout', status: 504, ready: false, alive: false });
});

test('three concurrent pages share one serialized model stream without HTTP 429 failures', async t => {
  let active = 0;
  let peak = 0;
  const baseUrl = await server(t, async (req, res) => {
    active += 1;
    peak = Math.max(peak, active);
    if (active > 1) {
      active -= 1;
      reply(res, { error: 'inference_busy' }, 429);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    reply(res, { ...decision, candidateId: payload.candidates[0].id });
  });
  const client = new LayaClient({ baseUrl });
  const results = await Promise.all([0, 1, 2].map(index => client.classifyIntro({
    text: 'Click to continue', candidates: [{ id: `intro${index}`, text: 'Click to continue' }],
  })));
  assert.equal(peak, 1);
  assert.deepEqual(results.map(result => result.candidateId), ['intro0', 'intro1', 'intro2']);
});

test('the bounded queue charges waiting time to the total classification deadline', async t => {
  const baseUrl = await server(t, (_req, res) => {
    setTimeout(() => reply(res, decision), 150);
  });
  const client = new LayaClient({ baseUrl, timeoutMs: 1000, queueTimeoutMs: 250, maxQueueLength: 2 });
  const started = Date.now();
  const results = await Promise.allSettled([
    client.classifyIntro(request), client.classifyIntro(request), client.classifyIntro(request),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'timeout');
  assert.equal(results[2].status, 'rejected');
  assert.equal(results[2].reason.code, 'queue_full');
  assert.ok(Date.now() - started < 750, 'waiting must consume the same overall deadline');
});
