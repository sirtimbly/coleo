# Execution Dependency Map

> Phase 0 deliverable for `phase0pl-64faef`. Source: `.project/plan.md`
> phase intros + `### Dependencies` sections, extracted 2026-09-22.
> "Declared" = explicit `### Dependencies` entry; "implied" = prose in
> the phase intro. Readiness for any item additionally requires the
> ADR-018 gate conjunction (leases, claims, approvals, evaluation
> locks, verified outputs) and ADR-017 output verification.

## Gate rules (apply to every phase)

- No phase starts until its prerequisites below are complete with
  recorded acceptance evidence — filenames and dirty-tree presence are
  not evidence (ADR-016/017).
- Rollback for all persistence work is restore-based (ADR-021): backups
  with version, location, retention, and drilled restore; no
  down-migrations. Event cutovers require dual-write + reconciliation.
- Evaluation outputs never mutate tasks/plans/leases/approvals without
  an explicit API-mediated action; evaluation locks gate operational
  evaluation runs.

## Phase gates

| Phase | Prerequisites | Services / migrations | Acceptance evidence | Approvals / rollback |
|---|---|---|---|---|
| 0 Planning gate | — (root) | `bun run typecheck`, scripts per ADR-019 | ADRs 001–022, `.project/status.md`, verification reports | Human architecture decisions (open: ADR-003 wording) |
| 1 API boundary | Declared: none. Implied: Phase 0 | API 8080, NATS 4222/8222; auto-migrations, epoch checks | Boundary tests, auth/WS/CLI integration tests | Rollback = restore compatible backup |
| 2 Observatory | Declared: 0, 1, Phase 1 acceptance | Web build (Vite), Playwright (port 4174) | Route/API-contract/browser regression tests | — |
| 2A Evaluation/swarm | Declared: 0, 1, model config + redaction rules | Evaluation lock (plan ops); bakeoffs offline-only | Fixture provenance, redaction checks | Human-label handling; no state mutation |
| 3 Planning refinement | Declared: none. Implied: Observatory/API, canonical plan format, task-file refs (ADR-017), Brain | API + DB | Discussion persistence/authorization tests | Preview-before-mutation approval |
| 4 Classification | Declared: 0, 1, 2A, 3 | Brain/MCP/CLI context paths | Any-arm-can-execute-any-classification proof | No arm-specialization fields |
| 5 Lifecycle + passes | Declared: Phase 0 status-report foundation, 2A, 4, claims, verified API boundary | Durable pass/lease/branch/diff storage (to build) | Atomic claim/lease tests, no-child-task proof | Lease-gated merge; human-review gates |
| 6 Tech debt | Declared: none. Implied: verified schema/migrations | SQLite utils; JSON-fallback removal | Backup/restore + interrupted-migration drills | Restore-based rollback |
| 7 Status reports | Declared: Phase 0 foundation, 1, 5, Maildir boundary | Maildir/API paths | Parsing, routing, aggregation tests | Human delivery approval where required |
| 8 Bugs | Declared: 5, 7 | Bug tables, priority/blocker state | Blocking/recovery tests vs gates | Human escalation for critical |
| 9 Agentic Brain | Declared: Phase 0 boundary decision, 2A, 4, 5, 7, 8 | Model provider + fallback; API-only tools (ADR-015) | Determination quality, fallback tests | Human approval gates; deterministic fallback |
| 10 Compression | Declared: Phase 0 vector decision, 4, 9, 16 | Vector history store | Threshold/reinjection tests | Redaction rules |
| 11 JetStream | Declared: none. Implied: verified NATS, API boundary, state handling | NATS JetStream streams, 7-day retention; dual-write | Replay/ordering/duplicate/consumer-recovery tests; SQLite parity | Approved migration plan only; SQLite fallback |
| 12 Status-history search | Declared: Phase 0 vector decision, 7, 11, 9, approved vector-DB decision | Qdrant (6333), embeddings, JetStream consumer | Failure/retention/filter/pagination tests | Outage must not corrupt SQLite/Maildir |
| 13 Code graph | Declared: 1, 4, 6, stable workspace access | SQLite graph store, Tree-sitter scanner | Freshness + MCP navigation tests | — |
| 14 Governance | Declared: Phase 0 governance decision, 5, 7, 12, human approvals | Proposal/consensus store | Quorum/conflict/override/e-stop tests | Human escalation; emergency stop |
| 15 Garden | Declared: 1, 2, 5, workspace events + claim data | WS or JetStream updates | Read-only consistency proof | Visualization-only; never a source of truth |
| 16 Harnesses | Declared: Phase 0 deployment decision, 1, 5, verified events | NATS, harness processes | Pluggability + restart-resilience tests | Deployment decision first |
| 17 Budget | Declared: 2, 4, 11-or-equivalent cost data, OpenCode API | Cost-event pipeline | Forecast-accuracy tests | No routing by model as specialization |
| 18 Arch/persistence | Declared: 5, 7, 11, approved persistence decisions | Per-boundary migrations | Task-file/Maildir/event/SQLite integration tests | Per-boundary rollback |
| 19 Cards/widgets | Declared: 2, verified view prefs + projection primitives | Browser only | Pointer/keyboard/persist/profile tests | — |
| 20 Brain-created tasks | Declared: 1, 5, 16, safe dev-server + handoff semantics | Dev-server log/restart control via Brain | Restart/handoff/conflict-recovery tests | Destructive ops via Brain coordination |
| 21 Refactoring | Declared: 5, claims system | File-size/refactor tooling | Threshold/escalation/claims tests | Single-next-task + dependency gates |
| 22 Notifications/deploy | Declared: Phase 0 deployment decision, auth/security, 11 event delivery, 14, selected target | Deployment target, proposal flow | Permission/failure/pause/rollback/traffic tests | Governance-routed deploys; rollback with pause |
| 23 Production | Declared: all above + Phase 0 deployment, persistence, vector decisions + selected target | Full topology | Install/migration/backup/restore/rollback/notification/monitoring validation + disaster-recovery drills | Release evidence in status/acceptance/changelog |

## Critical paths and fan-ins

- Lifecycle fan-in: Phase 5 gates 7, 8, 9, 13, 14, 15, 16, 18, 20, 21.
- Event fan-in: Phase 11 gates 12, 17, 18, 22.
- Unmade Phase 0 decisions block: deployment target → 16, 22, 23;
  vector-search/embedding → 10, 12, 23; production persistence → 23;
  governance → 14.
- Missing declared `### Dependencies` (rely on prose, consider
  amending): Phases 1, 3, 6, 11.

## Evaluation dependencies

2A foundations → 4 (classifier changes), 9 (agent behavior), 10, 12;
evaluation locks gate operational runs; bakeoff/fixture outputs are
evidence only. Offline scripts (`classification-bakeoff`,
`eval-human-history`, `eval-swarm-window`) are not gates.

## Acceptance-evidence inventory (2026-09-22)

- Present: `.project/acceptance/phase-1.md`; typecheck pass; runtime-stack
  validation report; evaluation-lock verification report; failure-path
  suites (prepare-repository 12, onboarding 7).
- Missing: acceptance records for all other phases; fresh unit/
  integration/e2e/web-build runs (see ADR-019 delivery sequence).
