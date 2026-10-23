# Reviewed round executor implementation plan

## Goal
Complete the existing public-DEMO loop: capture -> human/MCP classification -> local execution of every selected branch -> new captures -> next reviewed round. Record the ordered HTTP/WebSocket evidence for every action until an actual game request is observed. Preserve the original classifier and OAuth connection.

## Architecture / design
Cloudflare remains the private queue, not a browser host. A local long-running Playwright executor consumes current decisions, uses a durable finite frontier and uploads each resulting screen. Each batch has a frozen list of item IDs; a temporarily empty global queue never means a finished batch. The next batch is produced only after the current batch is classified. Existing captures can seed the first frontier. The executor saves replay paths, never guesses hidden controls, and never calls model APIs to replace manual classification.

Replay each sibling from a fresh public demo context, applying reviewed ancestors in order. Resolve current structured controls by stable path/label rather than reusing numbered IDs; require matching screen signatures for visual coordinates. Unknown, changed or ambiguous screens are requeued rather than clicked. Record a pending local action journal before clicks; interruption is reported as uncertain, not retried silently. Stop branches on observed game requests, loops, depth/branch budgets or missing evidence, with distinct statuses. A later phase may continue bonus states; a captured request is not proof of full provider coverage.

Publish sanitized action traces to private R2 through authenticated Worker routes, with original URL/method, ordered query/form fields, request and response bodies, status, and parent/child action provenance. Dynamic session/auth values remain placeholders; do not expose reusable secrets. HTTP replay is explicit and uses a fresh session binding, a fixed endpoint allowlist, no redirect forwarding and no automatic retry of mutating requests. Captured and replay-verified are separate outcomes.

## Constraints
- Node >=22.13, existing Playwright, D1, R2 and token roles.
- Public demos only, one local executor per outbox, persisted <=3 new page starts/minute.
- No auto-generated classifications. No real-money accounts or payments.
- Preserve all existing records; additions and idempotent writes only.
- Cloudflare build/deploy and Windows process startup are separate; updating Worker code cannot hot-reload a running local Node process.

## Tasks / verification
- [ ] Add failing tests for frozen batch barriers, durable frontier, revision/hash checks, independent siblings, loop/depth handling and interrupted actions.
- [ ] Implement local round planner and authenticated Cloudflare client; stage children before advancing the batch.
- [ ] Implement Playwright replay/capture executor reusing extraction/frame/intro/speed helpers. Include executable spin/confirm classifications while excluding routine settings.
- [ ] Add action-correlated protocol traces with redaction, bounded storage, immutable upload and private retrieval. Test auth, traversal, oversize, query ordering, tokens and mixed-case keys.
- [ ] Add explicit HTTP replay with session binding and fail-closed unresolved values; test with a localhost test server, no live wagers.
- [ ] Connect the Windows collector worker to the integrated loop, preserving configured manifest, endpoint, credentials and browser path.
- [ ] Run existing and new Node tests, syntax checks and Playwright fixture integration; verify in CI before fast-forwarding main.
- [ ] Verify GitHub/Cloudflare deployment state and report the exact commit, verified scope and remaining runtime steps.

## Review focus
An upload response lost after success must not duplicate a child. A replaced classification must not be executed. A crash after a click must not replay that action automatically. Captures from an in-progress producer must not open the next batch prematurely. Sanitized credentials must never be sent literally during HTTP replay. Browser network failures and provider error responses must not become validated results.
