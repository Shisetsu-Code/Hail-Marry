# Dynamic workforce: discovery, catalogue, classification and branches

The repository has **two kinds of queues**, coordinated without sharing sessions:

* **Cloudflare D1 workforce_jobs**: durable discovery and catalog tickets, prioritized per provider. Each ticket has a compare-and-swap lease, lease renewal, idempotent identity, retry backoff and bounded attempts. A failed game/provider does not block other tickets. The Cloudflare Worker is a **control plane**, not a Chromium host.
* **Existing D1 items and classification history**: structured and visual/hybrid review. MCP human/vision agents still use next_item, save_and_next and queue_stats. The optional local classification agents process **only high-confidence structured Pragmatic runtime controls**; unknown/ambiguous structured captures become needs_review for manual audit. They never simulate visual understanding.
* **Existing branch journal**: the local round runner continues independently by game. A single managed branch runner per outbox protects against parallel replay of the same wager.
* **One Sync process**: transfers local JPEGs and diagnostics to R2/D1. No GitHub screenshot storage.

The local/workforce.mjs supervisor reads live backlog every 15s and spawns/stops agent processes with a bounded slot budget. The default is **five workers total**, with **at most three browser-capable workers**. Role limits: one discovery, two catalogue, two structured classification, one branch executor. Demand reallocates unused slots; subprocesses shut down gracefully on downscaling. The existing shared disk rate limiter still caps public demo starts to **three per minute** across capture/branch processes. The supervisor writes .local-state/workforce-status.json with assignments, backlog and active PIDs.

For automatic deployment on every `main` update, use **[GitHub and Windows auto-updates](AUTO_UPDATES.md)**. One-time Cloudflare credentials and an opt-in deployment switch are required.

## Deploy the D1 schema and Worker

The new scheduler needs the additive 0003_dynamic_workforce.sql migration. Existing items, classifications and R2 captures are untouched.

~~~powershell
cd $HOME\hybrid-cloud-fuzzer
git pull --ff-only
npm run check
npm test
npx wrangler d1 migrations apply hybrid-cloud-fuzzer --remote
~~~

The repository can deploy to Cloudflare Builds from main. A successful GitHub Actions test or a source push alone does **not** prove the production Worker was published. If your Cloudflare Builds connection has not updated the Worker, deploy from the authenticated Wrangler session:

~~~powershell
npx wrangler deploy
~~~

Check https://hybrid-cloud-fuzzer.braian-n-l.workers.dev/health: expect schemaVersion:3 and workforceReady:true. Never send REVIEW_TOKEN, INGEST_TOKEN or MCP_TOKEN in a URL or share them in chat.

## Activate from the existing Windows collector

Dynamic mode replaces the legacy Capture and Branches processes with one Workforce supervisor. Sync stays running. Stop the old workers before switching modes, once the remote schema and Worker are active:

~~~powershell
cd $HOME\hybrid-cloud-fuzzer
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-control.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-control.ps1 -Action Start -DynamicWorkers
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-control.ps1 -Action Status
Get-Content .\.local-state\workforce-status.json
~~~

-DynamicWorkers persists dynamicWorkers=true in your existing local config. Future starts can omit the switch. No token rotation, new passwords or reclassification is required. All workers use the same run ID from the private local manifest.

For a new checkout:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-setup.ps1 -RunId hybrid-pragmatic-20261019 -DynamicWorkers
~~~

Configure the two **already existing** ingest/review credentials using the repository's DPAPI bootstrap only if they are not already saved. Adult confirmation still requires your explicit adultConfirmed=true configuration; dynamic mode does not bypass age gates.

Change maxWorkers (1..24) and browserWorkers (1..8) in .local-state/collector-control.json to fit the PC. A 32-GB PC can start with the conservative 5/3 defaults, and lower them if memory use is high. Browser process count is a ceiling, **not** a throughput promise.

## Add new provider discovery sources

The default examples/provider-sources.json is deliberately empty. This prevents unrestricted web crawling, unknown real-money hosts and blind execution against unverified sites.

Copy examples/provider-sources.example.json to a private .local-state/provider-sources.json, configure public HTTPS catalogue URLs and a tightly scoped path pattern, and set:

* id: a unique source slug.
* provider: provider identifier, e.g. pragmatic or another provider with an authorized public demo catalogue.
* indexUrls: explicitly approved, public HTTPS index pages on the same origin as gameUrlPrefix.
* gameUrlPrefix and gamePathPattern: exact permitted game paths (no cross-origin links, secrets or query strings).
* approved:true, enabled:true only after personally validating the source.
* verifiedDemo:true only when the resulting links are actual publicly accessible **demo** games; otherwise discovery collects a summary for human review and does **not** enqueue browser capture.

Point providerSourcesPath in the private Windows config at this file and restart Workforce. For each active source, the manager schedules a discovery scan once every six hours; deduplication is by run/provider/subject in D1. New games become catalogue tickets, and their completed captures enter the existing classification queue. An unfamiliar provider may require a new runtime adapter and screenshots for visual review; merely finding links does not make its controls or network endpoints validated.

In addition to discovery, entries in the manifest's games array seed independent, idempotent catalogue tickets. With an empty manifest, existing D1 classifications continue to drive branch work; there are no fabricated new games.

## Status, controls and limits

Authenticated REST endpoints (existing REVIEW_TOKEN):

| Endpoint | Purpose |
|---|---|
| POST /v1/work/jobs | Add up to 20 discovery/catalog tickets idempotently |
| POST /v1/work/claim | CAS-lease next provider/role ticket |
| POST /v1/work/renew | Renew one owned lease |
| POST /v1/work/finish | Mark ticket done or retry with backoff |
| POST /v1/work/agent | Heartbeat / capacity registration |
| GET /v1/work/stats?runId=... | Role demand, capture backlog, active agents |

Existing POST /v1/claim also accepts mode:structured for safe classifier isolation. MCP review and needs_review remain unchanged.

The workforce does not run in the background without the Windows supervisor or another connected agent. It does not start new Cloudflare Worker deployments or allocate extra paid cloud compute. For remote PCs, run independent local supervisors using the same authenticated D1 queue with different outboxes; ticket leases protect discovery/catalog jobs across hosts. Cross-host branch execution is **not** yet distributed: use one branch owner per run until per-game journal sharding is implemented.

Failed/unknown actions are not retried as wagers. A screenshot with a purchase confirmation is not proof of a successful HTTP wager; only action-correlated network evidence can establish that the request was observed.
