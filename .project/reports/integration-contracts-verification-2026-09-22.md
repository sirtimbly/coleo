# Integration Contracts Verification (2026-09-22)

Task: `phase1co-83615a`.

## Verdict: VERIFIED (one environmental failure, filed as bug)

Contract matrix across `src/api`, `src/db`, `src/nats`, `src/mcp`,
`src/cli`, `src/project-setup`, `src/scripts` suites (71 files):
**491 pass, 1 fail** — plus e2e failure-matrix, error-boundary,
dashboard, and activity suites green.

| Contract | Evidence |
|---|---|
| Auth failures | Route-suite 401s; `websocket-proxy-auth` (upgrade + in-band key); bugs-401 e2e alert |
| Unavailable deps | arms/garden abort e2e (explicit error states); JetStream-unavailable API fallback; Qdrant-degraded dashboard |
| Duplicate requests | Bridge envelope dedup; message-metrics idempotent upsert; spawn session/recover guards |
| Process exits | Evaluation-lock stale recovery; `cleanupOrphanedArms` → stopped + claims released |
| Stale state | Dashboard stale flags (never rendered as fresh); orphan reconciliation; version preconditions |
| Reconnects | WS backoff + ping + manual reconnect (unit + e2e); SSE native reconnect; aria-live notice |
| Partial persistence | status-report 400s never persist; bridge finish accounting; prepare-repository no-residue; onboarding partial-clone cleanup |

## The one failure (not a product defect)

`task-preparation.test.ts` → fallback case times out: the test clears
only `OPENAI_API_KEY`, but model config prefers the config-file
`brain.apiKey`, and the local working-tree `.coleo/config.toml`
currently holds a live key — so the test attempts a real network call.
Filed as a bug (test isolation + live key sitting in a modified
git-tracked file; verified the key is NOT committed — 0 `api_key`
lines in HEAD). Key value deliberately not reproduced anywhere.

No code changes required.
