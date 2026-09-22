# Verified Implementation Inventory

Task: `phase0pl-ca22c4` — Create a verified implementation inventory.
Baseline captured: 2026-09-22, HEAD `3aaf34c`, 149 modified/untracked paths
(dirty workspace; counts and results below are current-workspace, not a clean
baseline). All commands run from the repository root on 2026-09-22.

Classification legend:

- **verified-current-workspace**: behavior re-validated by running tests or
  builds on the current dirty workspace.
- **verified-baseline-only**: evidence exists from prior records but was not
  re-run here.
- **partial**: implementation exists; some aspect lacks automated evidence.

Checkboxes are keyed to `.project/plan.md` line numbers. No in-progress
(`[-]`/`[/]`) checkboxes exist in the plan; the 14 checked checkboxes reduce
to 11 unique items (Phase 4 deliverables at lines 258–260 are restated as
acceptance criteria at lines 279–281).

---

## Phase 0 (line 52): Reconcile the inventory snapshot with live repository state

- **Classification**: verified-baseline-only
- **Evidence source**: completed-task record (2026-09-19);
  `.project/reports/runtime-stack-validation-2026-09-22.md` corroborates the
  workspace-reconciliation discipline.
- **Validation command**: `git status --porcelain | wc -l` → `149`;
  `git rev-parse --short HEAD` → `3aaf34c`.
- **Runtime conditions**: none (git-only).
- **Known limitations**: the workspace remains dirty; all other rows in this
  inventory are current-workspace results, not clean-baseline results.
- **Verified after current changes**: yes — re-run for this inventory.

## Phase 2 (line 157): Enhance the Mail and Message Interface (sent view + threaded conversations)

- **Classification**: verified-current-workspace
- **Evidence source**: `src/web/src/pages/MessagingPage.tsx` (Inbox/Sent/Archived
  tabs), `src/web/src/pages/mail-page-utils.ts` (`buildMailThreads`),
  `src/web/src/workbench/MailThreadProjection.tsx`,
  `src/web/src/components/MessageModal.tsx` (thread headers),
  `src/api/routes/mail.ts` (`GET /mail/sent`, `POST /mail/send`, read/archive).
- **Validation command**:
  `bun test src/web/__tests__/mail-page-utils.test.ts src/web/__tests__/mail-api-client.test.ts`
  → **14 pass, 0 fail**.
- **Relevant tests**: `mail-page-utils.test.ts` (10 tests: threads across
  inbox/sent/archive, Coleo thread headers, mailbox filtering, keyboard
  navigation); `mail-api-client.test.ts` (5 tests: send payload, mark
  read/archive, thread identity on replies).
- **Runtime conditions**: API on 8080; Maildir under `.project/mail/`; WS mail
  events for live updates; Vite dev proxy.
- **Known limitations**: `GET /mail/sent`/`POST /mail/send` route behavior has
  no API-route unit test (threading covered client-side only); MCP/CLI-sent
  mail may not appear in the sent view.
- **Verified after current changes**: yes.

## Phase 3 (line 221): Add progress visualization

- **Classification**: verified-current-workspace
- **Evidence source**: `src/web/src/components/TaskProgressWidget.tsx`,
  `TaskChecklistProgress.tsx`, `src/web/src/pages/DashboardPage.tsx`,
  `src/api/routes/tasks.ts` (`GET /tasks/stats`, `GET /tasks/:id/checklist`),
  migrations 041/055/057 (`tasks.progress`, `task_checklist_items`).
- **Validation commands**:
  `bun test src/api/__tests__/tasks.test.ts` → **59 pass, 0 fail**;
  `bun test src/db/__tests__/migration-runner.test.ts` → **14 pass, 0 fail**.
- **Relevant tests**: `tasks.test.ts` (stats by status, aggregate progress
  stats); `migration-runner.test.ts` (checklist persistence/FK cascade);
  `adaptive-card-contracts.test.ts` (checklist card field).
- **Runtime conditions**: API + SQLite (auto-migrations); WS `tasks` channel.
- **Known limitations**: covers **tasks**, not plan items (the checkbox
  mentions plan items); no test for `GET /tasks/:id/checklist`; the web client
  defines checklist mutation methods with **no backing server endpoints**
  (GET-only on the server — dead client surface); widget components have no
  component tests.
- **Verified after current changes**: yes (server-side); UI rendering verified
  via `bun run web:build` (passes) and `bun run --cwd src/web lint` (clean).

## Phase 3 (line 222): Add collaborative discussion UI ("Architect" agent)

- **Classification**: partial (API verified-current-workspace; UI untested)
- **Evidence source**: `src/web/src/components/TaskDiscussionPanel.tsx`,
  `DiscussionComposer.tsx`, `PreparedTaskModal.tsx`,
  `src/api/routes/task-discussions.ts` (threaded CRUD, read receipts,
  24h edit window, blocked-task requeue on human reply),
  `src/api/routes/tasks.ts` (`POST /tasks/:id/prepare`),
  `src/api/services/task-preparation.ts` (LLM-backed preparation with
  deterministic fallback).
- **Validation command**:
  `bun test src/api/__tests__/task-discussions.test.ts src/api/__tests__/task-preparation.test.ts`
  → **30 pass, 1 fail** (see below).
- **Relevant tests**: `task-discussions.test.ts` (30+ tests: threading,
  pagination, requeue semantics, edit window, soft delete, unread counts);
  `task-preparation.test.ts` (fallback, mocked LLM parse, 404).
- **Runtime conditions**: API + SQLite (`task_comments`); WS `tasks` channel;
  brain LLM configured (else deterministic fallback).
- **Known limitations**: (1) the "fallback definition when no brain API key"
  test **times out on machines with a configured `.coleo/config.toml` key**
  (test only deletes `OPENAI_API_KEY` env, but the service loads real TOML
  config — bug filed: task-preparation fallback test timeout, 2026-09-22);
  result is environment-dependent, 30/31 here. (2) The agent is named "Task
  Preparation Agent", not "Architect"; no in-chat agent responder — the agent
  is invoked explicitly via the Prepare button. (3) No UI component/Playwright
  tests for the chat interface. (4) Follow-up plan items (lines 223, 227)
  remain unchecked, consistent with partial verification.
- **Verified after current changes**: API side yes (30/31, one env-dependent
  failure); UI side build-only.

## Phase 4 (lines 258/279): Arms receive discoveries when tasks are assigned

- **Classification**: partial
- **Evidence source**: `src/brain/prompt-generator.ts` (`generateContextBundle`
  :839-901 injects `formatDiscoverySummary` into the arm assignment prompt;
  `buildContextBundle` :1392-1440), `src/brain/discovery-summarizer.ts`
  (LLM summary with no-key fallback), delivery via
  `src/mcp/server.ts` (`get_context_bundle`, `get_full_briefing`),
  `src/cli/commands/brain.ts` (`prompt:context`),
  `src/brain/brain.ts` `applyDiscoveryActions` (:4453-4482, warning/error
  discoveries pushed to in-progress arms).
- **Validation command**:
  `bun test src/mcp/__tests__/server.test.ts src/api/__tests__/brain-swarm.test.ts`
  → **13 pass, 0 fail** (registration + storage coverage only).
- **Relevant tests**: `server.test.ts` (tool registration includes
  discovery-bearing bundle tools — no content assertion);
  `brain-swarm.test.ts` (real handler inserts discovery rows).
- **Runtime conditions**: bun; LLM key optional (summarizer fallback).
- **Known limitations**: **no test asserts discovery content appears in an arm
  assignment prompt**; the `applyDiscoveryActions` arm follow-up path
  (:4472-4481) has no test; `src/mcp/tools/discovery-tools.ts` is an explicit
  extraction stub.
- **Verified after current changes**: registration/storage yes; assignment-time
  delivery content unverified (gap recorded, not silently assumed).

## Phase 4 (lines 259/280): Discoveries are stored in SQLite with FTS5 search

- **Classification**: partial
- **Evidence source**: `src/db/migrations/schema-01.ts` `MIGRATION_015`
  (`discoveries` + `discoveries_fts` FTS5 virtual table with sync triggers),
  `MIGRATION_038` (table rebuild, FTS recreated), migration-catalog entries
  015/028/038/044; write path `src/api/routes/discoveries.ts:54-124`;
  `src/brain/brain.ts` `handleDiscovery` posts through the API.
- **Validation command**: `bun test src/api/__tests__/brain-swarm.test.ts`
  → real-handler storage path passes (part of the 13/13 above).
- **Relevant tests**: `brain-swarm.test.ts` (log_discovery inserts into real
  `discoveries` table).
- **Runtime conditions**: Bun's bundled SQLite (FTS5 assumed; no runtime
  feature probe exists).
- **Known limitations**: **no test asserts the FTS5 virtual table, trigger
  sync, or an actual `MATCH` query**; Brain storage depends on the API being
  up (by design, ADR-012).
- **Verified after current changes**: storage yes; FTS5 search behavior
  unverified (gap recorded).

## Phase 4 (lines 260/281): The API provides discovery listing and search

- **Classification**: partial
- **Evidence source**: `src/api/routes/discoveries.ts` — `GET /` (filters +
  pagination :127), `GET /search` (FTS5 `MATCH` with LIKE fallback :297),
  `GET /:id` (:229), `GET /stats` (:383), `PATCH /:id` (:262); mounted at
  `/api/discoveries` in `src/api/server.ts`.
- **Validation command**: no dedicated route test exists;
  `bun run test:e2e:web` covers UI-against-mocked-API only.
- **Relevant tests**: none against the real route (e2e discovery UI tests use
  in-memory mocks in `e2e/support/fixtures.ts`).
- **Runtime conditions**: API + migrated SQLite.
- **Known limitations**: **zero automated coverage of list/search/stats
  against the real route**; `/search` silently degrades to LIKE on any FTS
  error (FTS5 absence would go unnoticed). Route ordering: `GET /:id` is
  registered before `/search` and `/stats`; Hono's trie gives static segments
  precedence over params, so no shadowing occurs — but this precedence is
  behavior-dependent and worth a live smoke check when the API next runs.
- **Verified after current changes**: not re-verified (no executable evidence
  path beyond reading the code); gap recorded.

## Phase 15 (line 988): Add a radial coordinate system

- **Classification**: verified-current-workspace (build gate only)
- **Evidence source**: `src/api/routes/garden-scene.ts` (`reefHashPosition`,
  radial rings around `BRAIN_POSITION`), `src/api/routes/garden-utils.ts`
  (`generateCoords`), `src/web/src/components/garden/GardenCanvas.tsx`
  (`reefPositionFromId`, rings for bugs/discoveries).
- **Validation commands**: `bun run web:build` → **passes** (759ms; chunk-size
  warning only); `bun run --cwd src/web lint` → clean; `bun run typecheck` →
  garden-related files clean (one unrelated failure in the untracked
  `src/brain/swarm/evaluator.ts`, another arm's in-progress work).
- **Relevant tests**: **none** (grep across `__tests__/` and `e2e/` finds no
  garden tests).
- **Runtime conditions**: API serving `GET /api/garden/scene`; SQLite; NATS
  JetStream optional (degrades to empty recent-activity).
- **Known limitations**: deterministic hash layout only (no collision/force
  relaxation); positions can jump on 5s REST refetches; no math tests.
- **Verified after current changes**: compile/build level yes; behavior level
  unverified (no tests exist).

## Phase 15 (line 992): Add interactive navigation

- **Classification**: verified-current-workspace (build gate only)
- **Evidence source**: `GardenCanvas.tsx` — `OrbitControls` (damping,
  distance/polar clamps), `KeyboardNavigator` (WASD/arrows, :1271-1333),
  `FollowSelection` (eased follow, :1335-1369), per-node `onClick` selection;
  `src/web/src/pages/GardenPage.tsx`; `GardenControlsPanel.tsx`;
  `GardenInspector.tsx`.
- **Validation commands / tests**: same build/lint results as above; **no
  automated tests**.
- **Runtime conditions**: as above.
- **Known limitations**: keyboard nav ignores modifier keys; camera follow can
  fight manual OrbitControls input.
- **Verified after current changes**: compile/build level yes.

## Phase 15 (line 993): Generate octopus avatars for arms with reuse logic and color/personality traits

- **Classification**: verified-current-workspace (build gate only)
- **Evidence source**: `GardenCanvas.tsx` `ArmTip` (:724-973, memoized
  16-segment tentacle with suckers, per-frame undulation, re-aiming at current
  task/bug/anchor), module-level shared `ARM_SEGMENT_DEFS`/`ARM_JOINT_RADII`/
  `ARM_SEGMENT_COLORS` (:694-722, computed once, reused), `TentacleLink`,
  `toneForArm` (:260).
- **Validation commands / tests**: build/lint as above; **no automated tests**.
- **Known limitations**: all arms share one global orange gradient (no per-arm
  color variation despite the checkbox wording); "personality" is status-based
  label tone only; no asset pipeline (procedural geometry).
- **Verified after current changes**: compile/build level yes.

## Phase 15 (line 994): Add a Brain mascot with personality and animation

- **Classification**: verified-current-workspace (build gate only)
- **Evidence source**: `GardenCanvas.tsx` `BrainNode` (:443-657 — emissive
  body, glow, wireframe, tracking pupils with 3-6s retargeting,
  smile/frown driven by `brainIsFrowning`, cheeks, click-to-select).
- **Validation commands / tests**: build/lint as above; **no automated tests**.
- **Known limitations**: look targets are random, not event-driven; frown
  requires *all* arms stuck/dead; binary expression.
- **Verified after current changes**: compile/build level yes.

---

## Cross-cutting validation results (2026-09-22, HEAD 3aaf34c, 149 dirty paths)

| Command | Result |
|---|---|
| `bun test src/web/__tests__/mail-page-utils.test.ts src/web/__tests__/mail-api-client.test.ts` | 14 pass, 0 fail |
| `bun test src/api/__tests__/tasks.test.ts` | 59 pass, 0 fail |
| `bun test src/db/__tests__/migration-runner.test.ts` | 14 pass, 0 fail |
| `bun test src/api/__tests__/task-discussions.test.ts src/api/__tests__/task-preparation.test.ts` | 30 pass, 1 fail (env-dependent timeout, bug filed) |
| `bun test src/api/__tests__/brain-swarm.test.ts src/mcp/__tests__/server.test.ts` | 13 pass, 0 fail |
| `bun run --cwd src/web lint` | clean |
| `bun run web:build` | passes (chunk-size warning only) |
| `bun run typecheck` | 1 unrelated failure (untracked `src/brain/swarm/evaluator.ts`, other arm's WIP) |

## Notable gaps surfaced by this inventory

1. Discovery list/search/FTS5 routes have no automated coverage (Phase 4
   items partially verified at best).
2. Garden visualization (all four Phase 15 checkboxes) has zero automated
   tests; verification is build-level only. The matching unchecked plan item
   ("Add performance, accessibility, reduced-motion, and unavailable-event
   rendering tests") is consistent with this gap.
3. `src/web/src/lib/api.ts` checklist mutation client methods have no backing
   server endpoints (dead client surface).
4. Progress visualization covers tasks, not plan items as the checkbox words
   it.
5. task-preparation fallback test is environment-dependent (bug filed
   2026-09-22).
