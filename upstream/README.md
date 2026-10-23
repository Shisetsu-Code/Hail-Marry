# Hybrid Cloud Fuzzer source snapshot

The `hybrid-cloud-fuzzer/` directory is a complete tracked-source snapshot of [Shisetsu-Code/hybrid-cloud-fuzzer](https://github.com/Shisetsu-Code/hybrid-cloud-fuzzer) at **045d403e06f8255d92f1e393a755edfeed5da0c3**.

It preserves the original Cloudflare coordinator, local executors, migrations, tests and documentation. Nested `.github/workflows` files are source references, not Hail-Marry workflows. Its original deployment configuration targets the existing production environment; it is not used by this classifier.

The Hail-Marry classifier actively reuses `src/candidates.js` for normalized-point validation and `local/visual-match.js` for reviewed screenshot matching. Its versioned schema retains mode, capture identity, ordered ante+spin steps and complete screen ancestry that the upstream compact marks schema does not retain.
