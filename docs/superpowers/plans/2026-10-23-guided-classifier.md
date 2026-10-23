# Guided Classifier Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated components and a whole-change review. The user explicitly requested implementation and a running UI; proceed with the specified five modes plus Q.

**Goal:** Deliver a live, authenticated Hail-Marry classifier that records reusable game routes and executes the user's explicitly marked demo actions.

**Architecture:** Inert source snapshot of Hybrid Cloud Fuzzer plus a Node/Playwright classifier service. Spanish web UI, immutable capture graph and isolated sessions; GitHub Actions hosts the browser and server, with a temporary tunnel and durable repository data.

**Tech Stack:** Node >=22, existing pinned Playwright, plain browser JS/CSS, GitHub Actions.

**Spec:** docs/guided-classifier-spec.md

## Global Constraints

Five modes 1–5 plus Q, exactly as in the spec. Existing original Cloudflare queues/bindings are untouched. Normal spin marking and mode 5 do not issue inputs. No unverified transaction is marked completed. All requests bound to current image revision/hash and idempotency key. Existing observer/BFS policies remain available separately.

## Review Focus

Stale tab or image cannot trigger a click; duplicate clicks/retries cannot repeat purchases; antebet cannot use another game's Spin; nested menu/confirm/cancel ancestry must survive export; saved state must survive runner termination without automatically replaying actions.

### Task 1: Browser runner

Files: classifier/runner.mjs, classifier/test/runner.test.mjs, classifier/fixtures/game.html.
Interfaces: exact BrowserRunner/Observation contract in the spec.
- [x] Write failing browser behavior tests for Q, stale image/session, menu/purchase transitions, ante then Spin, and independent games.
- [x] Run tests and inspect the expected missing behavior failures.
- [x] Implement using upstream visual matcher/inspection with fresh target checks.
- [x] Verify tests against real Chromium and report exact commands/results.

### Task 2: Classification UI

Files: classifier/public/index.html, app.js, styles.css; classifier/test/ui.test.mjs.
Interfaces: exact REST schema in the spec; mock only transport in focused UI tests.
- [x] Test key mapping, coordinates with image scaling, input-focus exclusions, mode 5 and Q, auth propagation and stale response handling.
- [x] Implement screenshot stage, mode toolbar, per-game queue, actions/history and export.
- [x] Verify in Chromium at desktop and narrow widths.

### Task 3: Store, API and durable deployment

Files: classifier/store.mjs, server.mjs, publisher.mjs, main.mjs, test/store.test.mjs, test/server.test.mjs, scripts/start-classifier.mjs, config/classifier-session.json, .github/workflows/classifier.yml, upstream source snapshot.
Interfaces: REST API and runner contract in spec.
- [x] Write failing tests for mode validation, idempotency, stale references, ante dependency, multiple menus and graph export.
- [x] Implement atomic store and authenticated same-origin API with per-game mutation locking.
- [x] Integrate runner, frontend, immutable JPEGs, repository data checkpointing.
- [x] Run baseline/new test suites and real UI fixture flow; independently review complete changes.
- [x] Publish to Hail-Marry, start workflow and verify saved demo captures: two usable screens and one mobile screen pending.
- [x] Verify authenticated UI against the real local server/browser and check public tunnel health from the GitHub runner.
- [x] Prepare the replacement session URL for handoff, verify its recorded expiration and report that this development environment's HTTP 403 prevents an authenticated external tunnel check. See docs/guided-classifier-validation-2026-10-23.md for evidence and limits.

## Decisions

Ruling: use a GitHub-hosted browser and authenticated temporary tunnel because the requested immediate Q/menu/ante actions require a live session; a static screenshot app alone would not satisfy the request.
Ruling: store only the bearer key hash in source; keep raw key out of public logs and artifacts.
Ruling: copy source into an inert upstream path and add a new schema because the upstream save endpoint strips the required mode/route fields.
