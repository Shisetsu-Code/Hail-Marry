# Verification record — 2026-10-19

Environment: local Node.js v22.16.0, experimental `node:sqlite` test database,
R2 mock with private in-memory JPEGs, HTTP requests to the actual Worker handler.

- `npm run check`: PASS (all source entrypoints parsed).
- `npm test`: **28 passed / 0 failed**.
- Tested: multi-provider candidates, opaque-canvas fallback, normalized coordinates,
  known intro handling, game-iframe selection, local Fuzzer-Manual import,
  direct GitHub-only import with resume, R2 private image, D1 queue/leases,
  transactionally saved decisions + history, obsolete-feed exclusion, CAS against
  stale images, MCP JSON-RPC including `save_and_next`, optional JPEG retrieval,
  complete import → sync → MCP → decisions chain, deployment health/MCP probe.

Limitations: this test harness cannot authenticate to the user's Cloudflare account,
create a live R2/D1 instance, or confirm that Playtech/3Oaks/RubyPlay/Belatra expose
non-DOM runtime controls. These providers use visual fallback until a dedicated
adapter is implemented and verified against real public DEMOs. CI on GitHub should
repeat the test suite on Node 22 and 24 after Codex publishes the code.
