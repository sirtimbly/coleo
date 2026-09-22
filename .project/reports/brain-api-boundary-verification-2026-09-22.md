# Brain/API Boundary Verification (2026-09-22)

Task: `phase1co-e5d480` — verify the Brain/API boundary refactor.
Contract: ADR-015 (Brain Agent is API-only), ADR-012 (API-owned SQLite),
`.project/plans/brain-api-boundary-execution-plan.md`.

Method: static import/call audit of `src/brain/**` runtime code
(tests excluded), caller review, and focused test runs.

## Verdict: NOT CONFORMANT — refactor partially implemented

### Conformant

- `src/brain/brain.ts` publishes events only via `publishEventViaApi`
  (`src/brain/brain-api-client.ts`); its sole `nats/*` import is the
  pure `subjectToken` string helper. Same for `health-monitor.ts` and
  `permission-engine.ts` subject-token usage.
- Type-only `EventData` imports (`activity-types.ts`,
  `activity-analyzer.ts`) create no runtime dependency.
- No harness or OpenCode SDK imports anywhere in Brain runtime.
- No `new Database` / `openDatabase` / `getDatabase` in Brain runtime.
- Status-report validation gap is FIXED by commit `fdfbbff`: malformed
  enums/arrays/empty summaries return explicit 400s, rejected reports
  never persist (with tests + human ADR-022 status-report-foundations).

### Violations (direct JetStream value imports in Brain runtime)

| File | Line | Usage |
|---|---|---|
| `src/brain/event-window.ts` | 9 | `eventStore` imported alongside types |
| `src/brain/agent/tools/dependencies.ts` | 7, 63 | publishes `dependency_reported` straight to JetStream |
| `src/brain/health-monitor.ts` | 23 | `eventStore` import |
| `src/brain/permission-engine.ts` | 13 | `eventStore` import |

Each must move to API-backed event routes (or an API-mediated adapter)
before the refactor can be recorded complete. The
`src/mcp` direct-SQLite path remains the documented ADR-012 migration
bridge only.

### Incidental fix in this pass

Duplicate ADR-022 numbering (`022-workspace-startup-contract.md` vs the
human's `022-status-report-foundations.md`, commit `fdfbbff`): the
human numbering stands; the startup contract is now
`024-workspace-startup-contract.md`, with `status.md` and the
dependency map updated.

## Next steps

Phase 1 cleanup tasks must eliminate the four `eventStore` usages
above (route through `publishEventViaApi` or new API event routes),
add regression tests asserting no `nats/jetstream` value imports in
`src/brain` runtime, then re-run this verification.
