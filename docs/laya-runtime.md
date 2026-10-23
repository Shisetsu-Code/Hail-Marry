# Laya runtime for the Hail-Marry prototype

Laya receives text that the scanner has already read from DOM controls or Tesseract OCR. It does not read screenshots, locate pixels, or implement OCR. This integration asks the model two typed questions: whether the screen is an introduction that can be continued/dismissed, and which submitted control performs that action. The scanner retains the coordinates and must revalidate the current page before clicking.

## Pinned installation

The initial target is GitHub Actions on Linux x64 with Python 3.11. Install the CPU wheel explicitly, then the requirements:

```bash
python -m pip install torch==2.8.0+cpu --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r requirements-laya.txt
python -m pip check
```

| Component | Pin |
| --- | --- |
| Laya Python package | `0.4.14` |
| PyTorch | `2.8.0+cpu` |
| Transformers | `5.0.0` |
| Hugging Face Hub | `1.3.4` |
| Tokenizers | `0.22.2` |
| Safetensors | `0.7.0` |
| NumPy | `2.3.3` |
| Checkpoint | `convaiinnovations/laya-multilingual` |
| Checkpoint revision | `1720e3e3357cfe1e281542e223f8273b0890ca34` |
| Weight SHA-256 | `9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204` |

These are exact direct-dependency pins, not a complete transitive dependency lock. Preserve `pip freeze`, Python version, runner details, logs and fixture reports from the GitHub run when comparing results.

The [published model card](https://huggingface.co/convaiinnovations/laya-multilingual) describes the multilingual model as 322 million parameters; it is smaller than the published 421 million parameter English and typed-decisions checkpoints. The [pinned artifact metadata](https://huggingface.co/api/models/convaiinnovations/laya-multilingual/revision/1720e3e3357cfe1e281542e223f8273b0890ca34?blobs=true) lists 643,835,514 bytes of weights and 34,363,188 bytes for the tokenizer, approximately 678 MB combined. Loading fp16 weights into fp32 CPU parameters requires roughly 1.29 GB for parameters alone; framework allocations, temporary tensors and browser processes add memory. That is an estimate, not a measured peak.

The standard Linux x64 GitHub runner has [16 GB RAM for public repositories, or 8 GB for private repositories, and 14 GB SSD](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). One checkpoint and two model threads are the starting configuration. Do not load all Laya Router checkpoints or install CUDA wheels for this CPU test. Startup needs Hugging Face access on the first download; later runs can reuse a cache keyed to the checkpoint revision. Model download bytes should not be committed to this repository.

## Start and verify

```bash
USE_TF=0 USE_TORCH=1 TOKENIZERS_PARALLELISM=false \
python -u python/laya_server.py --port 8765 --threads 2 \
  --min-confidence 0.80 --max-state-tokens 512
```

The service binds to `127.0.0.1` only. It downloads/verifies the pinned weights, loads the CPU model and performs a real warmup forward pass before opening the HTTP listener. Allow up to the default 600-second load deadline for a cold cache. A package, download, model construction or warmup failure exits with an error; it never substitutes a keyword classifier.

The default 12-second inference deadline terminates a stuck model worker and makes subsequent health checks fail. Restart the service after that failure. Node requests have a 15-second transport deadline including the response body. A shared `LayaClient` serializes model calls from concurrent pages, bounds total pending calls at eight, and allows 45 seconds per classification including time spent waiting. These limits can be set in the client constructor; browser pages remain concurrent.

Run the actual model smoke test in the GitHub job:

```bash
npm run test:laya
```

This command calls the running local service and saves fourteen input/response pairs to `artifacts/laya-smoke.json` before checking its semantic assertions. Required cases include the exact scanner payload `CLICK TO CONTINUE`, `TAP TO CONTINUE`, contextual introduction text, mixed controls in two orders, gameplay text, and `SPIN` / `BUY BONUS` / `BUY BONUS TO CONTINUE` negatives. Additional diagnostic cases compare casing, context and the actual short or bordered prompts read from public demos. Diagnostic abstentions remain visible and do not become actionable clicks. The JSON contains raw typed answers, confidence, timing and runtime metadata even when an assertion fails. A successful import or mocked client test is not evidence that the model passed these fixtures. The scanner's browser fixture separately checks OCR, targeting and post-action stability.

Fast boundary checks do not load a model:

```bash
node --test tests/laya-client.test.mjs
python -m py_compile python/laya_server.py
```

The boundary tests use a real loopback HTTP server and controlled response fixtures. They check invalid decisions, missing inference, unknown candidate IDs, low confidence, missing runtime, body timeouts, concurrent calls, queue limits and a stuck worker's actual process termination. The result interpreter is tested against the public Laya answer schema. They do not establish game-domain model accuracy.

## HTTP and JavaScript contract

`GET /health` returns HTTP 200 only while the loaded worker is alive. Its body includes `ready`, the pinned `model`, `runtime` versions/device/thread count and the real `warmup` decision. It returns HTTP 503 after worker failure.

`POST /classify-intro` accepts JSON with exactly these top-level fields:

```json
{
  "text": "Welcome. Click to continue.",
  "candidates": [
    {"id": "c0", "text": "Click to continue", "kind": "ocr"}
  ]
}
```

Limits: 8,000 text characters; eight candidates; 160 characters per label; 32 per optional kind; unique IDs of 1–80 letters, digits, or `_.:-`; 64 KiB request body. The JavaScript client sends only the fields above and preserves coordinates in the caller. OCR IDs with spaces should be mapped to request-local IDs such as `c0` and restored by the caller after the decision.

The serialized state is tokenized with the loaded checkpoint's tokenizer before inference. More than 512 state tokens produces `needs_review` with `inference: false`; text is never silently shortened. The model's total context is fixed at 1,024 tokens with a 256-token question budget. Any truncation or collapsed options reported by Laya produces `needs_review`, even if the reported confidence is high.

An actionable response has this shape:

```json
{
  "status": "ok",
  "action": "continue",
  "candidateId": "c0",
  "confidence": 0.94,
  "inference": true,
  "reason": "intro_action",
  "model": {
    "id": "convaiinnovations/laya-multilingual",
    "revision": "1720e3e3357cfe1e281542e223f8273b0890ca34"
  }
}
```

The confidence above is illustrative. Real responses include `details` with the intent/target answers and usage, plus `elapsedMs` when inference runs. The threshold uses the smaller of both `answer_confidence` values. The older `confidence` field has a different meaning for choice questions and is not used as the gate; see the [pinned answer decoder](https://github.com/NandhaKishorM/laya/blob/v0.4.14/laya/agent.py).

`action` is `continue`, `dismiss`, or `none`. Only `status: "ok"`, real `inference: true`, a submitted `candidateId` and confidence at or above 0.80 can be actionable. Abstentions use `action: "none"` and `candidateId: null`. `no_intro` may return `status: "ok"` to indicate a completed decision with no click. Empty text/no candidates and token-limit refusals use `inference: false`. Low confidence, no target or truncated evidence after a forward pass use `inference: true` with `status: "needs_review"`.

The service also rejects a model-selected label containing the scanner's explicit gameplay or purchase exclusions, such as `SPIN` or `BUY BONUS`. This produces `blocked_target_label`, retains the raw model answers and confidence, and records the rejected label in `details.guard`. It never substitutes another candidate. This boundary was added after a real mixed-candidate inference selected `SPIN` with high confidence; it does not correct that semantic error or make the mixed-candidate accuracy test pass. The short exclusion list is not universal language coverage.

```javascript
import { LayaClient } from './src/laya-client.mjs';

const laya = new LayaClient({ baseUrl: 'http://127.0.0.1:8765' });
await laya.health();
const decision = await laya.classifyIntro({
  text: 'Welcome. Click to continue.',
  candidates: [{ id: 'c0', text: 'Click to continue', kind: 'ocr' }],
});
```

`LayaClientError.code` distinguishes `invalid_input`, `invalid_response`, `http_error`, `unavailable`, `timeout`, and `queue_full`. HTTP failures have a `status` property. Failures throw; no fabricated success decision is returned. The caller must record them as failed/needs-review evidence and decide whether to stop that page.

## Accuracy and portability limits

This is a zero-shot text model used on game introductions. Model confidence is not a proven probability of a correct game click. Generic model benchmarks do not validate a particular provider, language, OCR font or animation. Preserve the screenshot, OCR text, original candidates, response and post-click screen when evaluating each game. Correct text interpretation still needs accurate OCR boxes and current-page targeting.

The 0.80 threshold is an initial conservative configuration, not a calibrated domain result. If an intro fixture abstains, the GitHub smoke test should fail and retain the evidence; do not suppress the failure or rename a heuristic decision as Laya inference. Real-game coverage and threshold calibration require labelled examples beyond the small demo fixtures.

The requirements target Linux CPU. Other platforms may need a different PyTorch wheel and must be verified separately when this prototype is ported. The direct dependency set and exact checkpoint are reproducible inputs; hardware, transitive packages and numerical differences can still affect latency and boundary confidence values.

Primary references checked for this integration: [Laya installation and quickstart](https://github.com/NandhaKishorM/laya), [PyPI 0.4.14](https://pypi.org/project/laya/0.4.14/), [pinned Laya loader and prediction API](https://github.com/NandhaKishorM/laya/blob/v0.4.14/laya/agent.py), [checkpoint revision](https://huggingface.co/convaiinnovations/laya-multilingual/commit/1720e3e3357cfe1e281542e223f8273b0890ca34), and [Transformers 5.0.0 metadata](https://pypi.org/pypi/transformers/5.0.0/json).
