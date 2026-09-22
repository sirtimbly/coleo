# Brain/API Boundary Verification (2026-09-22)

Task: `phase1co-e5d480` (verification) → `phase1co-859fb9` (cleanup).
Contract: ADR-015 (Brain Agent is API-only), ADR-012 (API-owned SQLite),
`.project/plans/brain-api-boundary-execution-plan.md` Phase 2.

Method: static import/call audit of `src/brain/**` runtime code
(tests excluded), caller review, and focused test runs.

## Verdict: CONFORMANT (after `phase1co-859fb9` cleanup)

The initial audit found 4 direct JetStream usages; all are migrated:

| Former violation | Resolution |
|---|---|
| `event-window.ts` default `?? eventStore` + `brainEventWindow` singleton | Constructor requires explicit `store`; API route owns `new BrainEventWindow({ store: eventStore })`; Brain injects `ApiEventStore` |
| `agent/tools/dependencies.ts` direct publish | Optional `ToolContext.publishEvent` (API-backed when wired) |
| `health-monitor.ts` 2 direct publishes + default window | Injected `publishEvent` + `eventStore`; wired in `Brain` to API |
| `permission-engine.ts` direct publish | Injected `publishEvent`; forwarded through health monitor |

New `src/brain/api-event-store.ts` implements `IEventStore` reads via
`GET /api/events/arms/:armId/window` and `/api/events/recent`;
stream-internals methods throw explicitly (no Brain callers).
`src/brain/__tests__/api-boundary.test.ts` fails on any runtime
NATS/JetStream/harness/OpenCode import in Brain code.

Incidental fixes in the same pass:

- `brain-api-client.ts` sent `Authorization: Bearer`, which the server
  never accepts — now sends `X-API-Key` like every other Brain caller.
- `publishEventViaApi` posted to nonexistent `POST /api/events` — now
  posts to `POST /api/events/internal/publish` with the subject contract.
- Duplicate ADR-022 resolved (startup contract → ADR-024).

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

### Violations (all resolved — see verdict above)

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

## Validation evidence (`phase1co-859fb9`)

- `bun run typecheck`: pass.
- New `api-boundary` + `api-event-store` suites: 5/5 pass.
- Brain suite: 302 pass, 19 todo, 1 unrelated pre-existing failure
  (`responsibility-settings` JEV template drift, owned elsewhere).
- API events/telemetry/activity + NATS + status-reports/project-setup
  suites: all pass.
- `src/mcp` direct-SQLite path unchanged: still the documented ADR-012
  migration bridge only.

## Next steps

None for the boundary itself. Watch items: wire a production
`ToolContext.publishEvent` when the agentic Brain tool path goes live;
extend the boundary test if new integration families appear.
