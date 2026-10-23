# Codex instructions — Hybrid Cloud Fuzzer

Read **[docs/CODEX_HANDOFF.md](docs/CODEX_HANDOFF.md)** and the canonical full runbook at:
https://github.com/Shisetsu-Code/Hybrid-actions/blob/main/docs/CODEX_DEPLOY_RUNBOOK.md

This repository is the **Cloudflare control plane** (D1/R2/MCP/OAuth) for the distributed GitHub Actions catalogue fleet in Shisetsu-Code/Hybrid-actions.

Deployment rules:
- Target **main** only. Run npm ci, npm run check, npm test before any production mutation; record main SHA and CI results.
- Preserve the existing Worker name, D1 DB binding, R2 bucket, OAuth KV and secrets in wrangler.toml. Back up D1 privately before applying migrations.
- Require additive migrations **0001–0004** on the **remote** D1. Successful /health must report schemaVersion>=4, workforceReady=true, pacingReady=true. An older >=2 status is NOT compatible with Hybrid-actions.
- Choose **one** deploy owner: GitHub Actions Deploy Cloudflare (main) **or** Cloudflare Workers Builds. A skipped deploy workflow is not proof of deployment.
- GitHub's CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets and ENABLE_CF_GITHUB_DEPLOY variable are configured in THIS repository. The separate Hybrid-actions repository needs HYBRID_REVIEW_TOKEN and HYBRID_INGEST_TOKEN. Never print/rotate/recreate existing secrets; use secure UI if Codex cannot manage them.
- Never silently change the historical runId hybrid-pragmatic-20261019 or the fresh fleet runId hybrid-actions-20261020, or reclassify old captures.
- Do not run real-money games or wager/spin actions during the deployment. A public DEMO catalogue capture is read-only; the branch executor is a separate reviewed workflow.
- If /health, migrations, GitHub Action runs, OAuth/MCP, approved provider URLs, or secret permissions are unavailable, report the exact blocker without inventing successful outcomes.
- If tests pass but production still reports schema 2, deployment is NOT complete. Do not enable 8 GitHub runners until schema 4 and providers are verified.

Provide a final operational report with repo SHAs, GitHub Action run links, D1 schema/migrations and backup, Cloudflare Worker deployment evidence, authenticated checks, provider policies, R2 IDs, outstanding visual review and blockers.
