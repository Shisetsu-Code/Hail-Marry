# Reviewed capture continuations

The local `round-runner.mjs --watch` polls reviewed decisions for its explicit
manifest run. Classification remains separate from browser execution. Pending,
leased and `needs_review` captures block their own game, without blocking other
games. Routine spin, autoplay, settings and stake adjustment controls are not
exploration branches. Public DEMO URLs must be approved by the manifest.

Migration `0005_branch_executions.sql` adds a durable Cloudflare execution ledger.
It does not update existing captures, classifications, secrets or provider pacing.

1. The engine derives a stable task ID from the parent ID, revision, source hash,
   selected action index and full reviewed ancestry.
2. `POST /v1/branches/claim` validates that exact decision and atomically grants
   one reservation. A game cannot have concurrent execution reservations. Old
   traces and deterministic child IDs also prevent replay.
3. The engine persists the reservation before opening the demo or clicking. It also acquires the existing global provider session and renews it before each click; disabled provider policies fail closed.
4. A successful action uploads its child capture and sanitized trace, then calls
   `POST /v1/branches/finish`. Completion requires matching parent, child and trace.
5. The child enters the ordinary classification queue, under the same run ID.
   The engine waits for its review before advancing that game again.

All three endpoints (`GET /v1/branches`, claim and finish) use REVIEW_TOKEN.
Execution tokens are not returned by the read endpoint. A different local
journal or another host cannot repeat a reserved/completed task. Migration
absence fails closed, rather than reverting to local-only execution.

The status `blocked` means the engine could not establish a safe action before a
click. `uncertain` means a click may have occurred. A process that disappears
after reserving remains `running`, conservatively reserved; there is deliberately
no timeout that automatically retries a possible purchase. Investigate these
cases before authorizing recovery. Interrupted uploads retry saved evidence,
never the click. This gives at-most-once attempts, not a promise of exactly-once
delivery across browser/network crashes.

`scripts/prepare-continuations.mjs --run-id=RUN` performs a read-only cloud audit
and writes a local manifest/plan. It never reclassifies or reopens tasks. The
Windows controller accepts `continuationOnly: true` to start only its Branches
worker, without restarting stopped catalogue collection or repository updates.

For an old Pragmatic screenshot whose metadata points to the corporate detail
page, the matching `.fun/en/slots/ID/` demo must be explicitly listed in the
manifest. The historical capture metadata is preserved.
