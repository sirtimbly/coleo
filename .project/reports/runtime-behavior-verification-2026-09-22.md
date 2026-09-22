# Runtime Behavior Verification (2026-09-22)

Task: `phase1co-7b2393` — verify foundation behavior with runtime
tests, not filenames.

## Verdict: VERIFIED

| Area | Runtime evidence |
|---|---|
| Brain polling | Poll loop, inbox consumption, and API-mediated publish covered by brain suites (302 pass; 1 unrelated JEV-template drift failure filed separately); smoke `brain-paths` stage exercises publish/read/queue against a live server |
| Maildir I/O | mail suites pass; smoke `maildir` stage round-trips write/list in a clean workspace |
| MCP server | mcp suites pass (tools incl. file-claim/reporting); direct-DB access remains the documented ADR-012 bridge |
| Arm spawning (+headless) | spawn/create/cleanup route suites pass (validation, recovery, orphan reconciliation); live-model spawn covered by model-gated regression scenarios, not smoke |
| CLI basics | `coleo status` exercised against the live smoke server; CLI unit suites pass; X-API-Key on REST and in-band WS auth |
| Type definitions | `bun run typecheck` clean |
| NATS integration | Real `nats-server` with JetStream in smoke (`nats` stage); bridge projector + dedup suites pass; API degrades to 503/empty without NATS |

## Evidence

- `bun run smoke:topology`: **10/10 pass** (fresh run this task)
- mail + mcp + harness suites: **83/83 pass**
- Prior Bearer/publish/JetStream mismatches confirmed fixed in-tree
  (commit `d9db755`); stale contrary discovery text is superseded.

No code changes required.
