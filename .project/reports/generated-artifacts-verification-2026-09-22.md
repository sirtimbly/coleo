# Generated + Deployment Artifacts Verification (2026-09-22)

Task: `phase1co-2d06a3`.

## Verdict: VERIFIED (two non-blocking follow-ups)

### Reproducibility — pass

- **Image tags:** `computeCloudflareAgentImageTag` is a sha256 content
  hash over the bundled entrypoint inputs plus pinned input files —
  deterministic by construction (3/3 tests pass).
- **Base images pinned:** `oven/bun:1.3/1.3.6-debian`,
  `debian:bookworm-slim`, `qdrant/qdrant:v1.13.2` (compose),
  `nats:2.10-alpine` (compose), `NATS_VERSION=2.12.3` (agent).
- **prepare-repository output:** conservative clone-or-keep semantics
  with approval-gated replacement, covered by 12 failure-path tests;
  reruns are idempotent and leave no residue.

### Not authoritative — pass

Generated outputs (`dist/`, `node_modules/`, coverage, caches,
`.coleo` runtime state) are gitignored build products; no code path
reads them as application state. The API-owned SQLite database
(migrations + checksums + orphan reconciliation) is the sole
authoritative store (ADR-016).

### Follow-ups (non-blocking)

- Unpinned inputs: `awscli` latest zip and `apt` snapshots float;
  pin or checksum them for fully reproducible images.
- Version skew: qdrant v1.13.2 (compose) vs v1.18.0 (control
  Dockerfile); nats 2.10 (compose) vs 2.12.3 (agent/install).
  Align intentionally with client compatibility checks.

No code changes required.
