# BFS navigation — public FUN/demo games only

## Objective

Explore the shortest UI paths to all visible **bonus purchase entries**, **bonus options**, **bet controls** and **ante-bet toggles**. Classify and save novel screens; preserve the exact route and evidence for every action. This is **not** a generic arbitrary click fuzzer. The navigator does not spin reels, start autoplay, click a final purchase confirmation, or make any real-money payment.

## State machine

`OPEN → WAIT (60s per fresh context) → OBSERVE (DOM/accessible engine/OCR) → RECORD → CLASSIFY → INTRO → ENUMERATE → BFS REPLAY → REVALIDATE → INPUT → SETTLE (1.5s) → OBSERVE → NEW STATE`.

- Each BFS node runs in its own isolated browser context. Other frontier nodes load concurrently, then independently **replay** short paths from a fresh DEMO session. This is robust against irreversible modals and isolated bonus state, but can be expensive: every new branch incurs the initial wait, OCR, and replay. BFS is ordered by path depth; it is not just selecting controls on one screenshot.
- Node identities are based on stable control labels/paths and OCR text, **not a pixel hash**; looping or duplicate UI screens are merged. A path may become invalid if the game's random intro or current balance changes; that node then becomes failed/needs review, never a guessed click.
- `BONUS ENTRY` opens the purchase menu. `BONUS OPTION` may enter its simulated pre-purchase flow when `--initiate-demo-purchase true`. Final **Confirm purchase**, Spin and Autoplay are always blocked. A valid demo URL is required even to open an interactive menu. User-provided real-money URLs are not accepted for BFS input.
- Each input target is reobserved immediately beforehand. DOM inputs use the verified `GameSession.actOnControl`; Canvas/OCR and private engine targets require stable text/geometry across additional observations. Their `availability` remains unknown until an actual interaction changes the UI. An input dispatched is **not** equivalent to a purchase executed.
- Up to three explicit startup prompts are advanced. Short `CONTINUE` is permitted only when no competing actionable gameplay DOM control is detected. If the prompt is ambiguous, it is queued for GPT review and the path stops.
- A changed visual/background animation alone is never treated as a new route. Unchanged OCR labels and geometry can be used for revalidation; the strict prior `GameSession` pixel-equality gate is not used by the new BFS OCR-input path.

## GPT classification and queue

Every new semantic screen/text is stored in `artifacts/bfs/<game>/review/gpt-review.jsonl` and indexed in `gpt-review-index.json`, including OCR text, screenshot name, path, candidate control labels and normalized coordinates. Identical packets are deduplicated per run. `bfs-graph.json` stores the shortest state paths, candidates and observed outcomes. Full per-node `report.json` and PNG screenshots remain in `artifacts/bfs/<game>/node-NNN/`.

By default `--gpt false` means **queue for GPT**, not an invented classification. This allows ChatGPT to review the saved packets, attach corrected labels and build a library of reusable routes. For live GPT classification in a controlled environment:

1. Configure the GitHub Actions `OPENAI_API_KEY` secret or local env; optionally `OPENAI_MODEL` (default `gpt-4.1-mini`). This is a separate API credential, not the ChatGPT UI session.
2. Pass `--gpt true`. Only OCR text and sanitized candidate labels/paths are sent to the Responses API, not the screenshot, cookies or page URL. JSON-schema output is validated against the submitted candidate IDs.
3. GPT's labels may guide discovery **only** when high-confidence, bound to a real candidate and revalidated. It cannot supply screen coordinates, circumvent forbidden actions, relabel SPIN as bonus entry, or enter a non-demo transaction. API failure leaves the text in the queue with an explicit error.

The GPT label is a hypothesis, not a click guarantee. The final policies and input effects are enforced by code. The model does not navigate by itself.

## Run

Prerequisite: Node 22, Playwright Chromium, Python 3.11, Tesseract, Pillow. Laya is **not** required for this BFS mode. The previous observer/Laya experiment remains separately available.

```bash
npm ci
npx playwright install --with-deps chromium
sudo apt-get install tesseract-ocr tesseract-ocr-eng
python -m pip install -r requirements-ocr.txt
npm test
npm run test:bfs
npm run bfs:live -- --config config/demos.json --games-concurrency 3 --branch-concurrency 2 --max-depth 2 --max-nodes 9 --initiate-demo-purchase true --gpt false
```

The GitHub workflow `BFS navigation / demo-only` runs the deterministic regression tests, the browser fixture, and the three public demos. It uploads `bfs-navigation-evidence` even if a later step fails.

## Evidence and limitations

The simulated fixture has two separate FUN bonus options, a delayed menu, bet adjustment controls, an ante toggle, a Spin decoy and a final purchase confirmation. Expected success requires visiting each bonus option and observing but **not clicking** the confirmation. These are simulation checks, not a real-provider endorsement.

Live results depend on accessible DOM/engine internals, OCR quality and geometry. The `unknown` state is not treated as confirmed availability. A screenshot with only `CONTINUE` can be advanced cautiously, but engine-private hit areas and unsupported transforms can still block a route.

This first implementation favors bounded accuracy over throughput. Context-per-BFS-branch reloading uses 60 seconds repeatedly; a future optimization can reuse reversible menu paths within one live session, while keeping fresh-context replay as recovery. The graph reports truncated frontiers and failures so missing branches are not silently called complete.

## Measured public-demo baseline (GitHub Actions 40032911477)

The baseline run passed all deterministic tests and the browser fixture, and the workflow itself was green; **real-provider exploration was partial**. The artifact contains per-node screenshots, OCR, input evidence, route graph, and pending GPT review requests.

- Controlled browser fixture: two simulated FUN bonus options reached; one final purchase confirmation blocked; 12 bet and seven ante control encounters across nodes; eight new text-review packets.
- Pragmatic 3 Dancing Monkeys: nine BFS visits (eight distinct observed states), 11 dispatched inputs including replays, and a screenshot proving the **BUY FREE SPINS $180** dialog was opened. Bet changes were observed, but **no final simulated purchase was executed**, no separate bonus options were verified, and no ante control was detected. The original run mistakenly interpreted private-engine `Button_Yes` / `Button_No` as new bonus entries because their ancestor contained `BuyFeature`; this is now explicitly blocked and covered by tests. The purchase dialog is terminal; underlying bet controls remain untrusted while the modal is visible.
- BGaming Three Lucky Monkeys: `CLICK ANYWHERE TO START` was clicked and the intro advanced (one dispatched input), but no actionable bonus/bet controls were exposed afterward.
- Play’n GO Amulet of Dead mobile: zero interactions and no confirmed bonus/bet controls; the tutorial/intro remained unresolved.

The full baseline run used nine nodes max per public game; fresh-context replay took about eleven minutes for the whole workflow. Subsequent push CI uses four nodes max and depth one for a faster real-provider smoke test, not exhaustive BFS. For deeper exploration, use the full explicit CLI in the Run section.

The classification queue is not an automatic ChatGPT session connector; unattended model classification requires an explicitly configured API credential. Missing credentials leave review packets pending, with no forged GPT decisions.
