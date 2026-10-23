/** Strict transport boundary for the pinned, local Laya text decision runtime. */
export const LAYA_MODEL = Object.freeze({
  id: 'convaiinnovations/laya-multilingual',
  revision: '1720e3e3357cfe1e281542e223f8273b0890ca34',
});

export class LayaClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'LayaClientError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

function fail(code, message) {
  throw new LayaClientError(code, message);
}

function pinnedModel(model) {
  return model?.id === LAYA_MODEL.id && model?.revision === LAYA_MODEL.revision;
}

function inputPayload(input) {
  if (!input || typeof input.text !== 'string' || input.text.length > 8000 ||
      !Array.isArray(input.candidates) || input.candidates.length > 8) {
    fail('invalid_input', 'Expected text (at most 8000 characters) and at most 8 candidates.');
  }
  const ids = new Set();
  const candidates = input.candidates.map(candidate => {
    if (!candidate || typeof candidate.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(candidate.id) ||
        ids.has(candidate.id) || typeof candidate.text !== 'string' || candidate.text.length > 160 ||
        (candidate.kind !== undefined && (typeof candidate.kind !== 'string' || candidate.kind.length > 32))) {
      fail('invalid_input', 'Candidate IDs must be unique; labels and kinds must meet the input limits.');
    }
    ids.add(candidate.id);
    // Coordinates remain owned by the scanner. The model never invents them.
    return { id: candidate.id, text: candidate.text, ...(candidate.kind === undefined ? {} : { kind: candidate.kind }) };
  });
  return { text: input.text, candidates };
}

function validateDecision(result, payload, minConfidence) {
  const valid = result && ['ok', 'needs_review'].includes(result.status) &&
    ['continue', 'dismiss', 'none'].includes(result.action) &&
    typeof result.confidence === 'number' && Number.isFinite(result.confidence) &&
    result.confidence >= 0 && result.confidence <= 1 &&
    typeof result.inference === 'boolean' && pinnedModel(result.model) &&
    typeof result.reason === 'string' && result.reason.length > 0 && result.reason.length <= 160;
  if (!valid) fail('invalid_response', 'Laya returned an invalid decision envelope or an unexpected model.');
  if (result.action === 'none') {
    if (result.candidateId !== null || (result.status === 'ok' && !result.inference)) {
      fail('invalid_response', 'An abstention cannot contain a click target or claim unperformed inference.');
    }
  } else if (result.status !== 'ok' || !result.inference || result.confidence < minConfidence ||
             !payload.candidates.some(candidate => candidate.id === result.candidateId)) {
    fail('invalid_response', 'An actionable Laya result needs real inference, sufficient confidence, and a submitted target.');
  }
  return result;
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > 65536 || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    fail('invalid_response', 'Expected a JSON response no larger than 64 KiB.');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_response', 'Laya returned an empty response.');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        fail('invalid_response', 'Laya returned a response larger than 64 KiB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) {
    throw new LayaClientError('invalid_response', 'Laya returned malformed JSON.', { cause });
  }
}

export class LayaClient {
  constructor({ baseUrl = 'http://127.0.0.1:8765', timeoutMs = 15000, minConfidence = 0.8,
    queueTimeoutMs = 45000, maxQueueLength = 8 } = {}) {
    let url;
    try { url = new URL(baseUrl); } catch { fail('invalid_input', 'Laya baseUrl must be a local HTTP URL.'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      fail('invalid_input', 'Laya baseUrl must be a loopback HTTP origin without credentials or a path.');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
        !Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > 120000 ||
        !Number.isInteger(maxQueueLength) || maxQueueLength < 1 || maxQueueLength > 64 ||
        !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      fail('invalid_input', 'Invalid Laya timeout or confidence threshold.');
    }
    this.baseUrl = url.origin;
    this.timeoutMs = timeoutMs;
    this.minConfidence = minConfidence;
    this.queueTimeoutMs = queueTimeoutMs;
    this.maxQueueLength = maxQueueLength;
    this.classificationQueue = [];
    this.classificationBusy = false;
  }

  async request(path, payload, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new LayaClientError('http_error', `Laya runtime returned HTTP ${response.status}.`, { status: response.status });
      }
      return await boundedJson(response);
    } catch (cause) {
      if (expired) throw new LayaClientError('timeout', `Laya exceeded its ${timeoutMs} ms request deadline.`, { cause });
      if (cause instanceof LayaClientError) throw cause;
      throw new LayaClientError('unavailable', 'Cannot reach the local Laya runtime.', { cause });
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    const result = await this.request('/health');
    if (result?.ready !== true || !pinnedModel(result.model) || result.runtime?.layaVersion !== '0.4.14' ||
        result.runtime?.device !== 'cpu') {
      fail('invalid_response', 'The pinned CPU Laya runtime is not ready.');
    }
    return result;
  }

  async classifyIntro(input) {
    const payload = inputPayload(input);
    if (this.classificationQueue.length + Number(this.classificationBusy) >= this.maxQueueLength) {
      fail('queue_full', 'The local Laya classification queue is full.');
    }
    return new Promise((resolve, reject) => {
      const entry = { payload, resolve, reject, deadline: Date.now() + this.queueTimeoutMs };
      entry.timer = setTimeout(() => {
        const index = this.classificationQueue.indexOf(entry);
        if (index !== -1) {
          this.classificationQueue.splice(index, 1);
          reject(new LayaClientError('timeout', 'Laya classification expired while waiting for the model.'));
        }
      }, this.queueTimeoutMs);
      this.classificationQueue.push(entry);
      this.drainClassifications();
    });
  }

  drainClassifications() {
    if (this.classificationBusy) return;
    const entry = this.classificationQueue.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    const remaining = entry.deadline - Date.now();
    if (remaining <= 0) {
      entry.reject(new LayaClientError('timeout', 'Laya classification expired while waiting for the model.'));
      this.drainClassifications();
      return;
    }
    this.classificationBusy = true;
    this.request('/classify-intro', entry.payload, Math.min(this.timeoutMs, remaining))
      .then(result => validateDecision(result, entry.payload, this.minConfidence))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.classificationBusy = false;
        this.drainClassifications();
      });
  }
}
