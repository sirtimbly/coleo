# Arm Context Index + Archive + Search Plan

## Objective

Create a durable, searchable context history for each arm that supports:

1. Search by free text
2. Filter by time range
3. Filter by task
4. Filter by git commit (and commit history metadata)
5. Access from both CLI and web UI

## Current State (Codebase Findings)

1. Arm runtime events are written to SQLite `arm_events` at ingest time in `src/api/server.ts`, but there is no first-class API route for querying those stored events.
2. Activity events are also published to JetStream (`src/nats/jetstream.ts`) but retention is only 7 days and not sufficient for long-term archive.
3. Task completion already captures `artifacts` (commit hashes/file paths) through MCP `complete_task` and persists them via task updates (`src/mcp/server.ts`, `src/brain/brain.ts`, `src/api/routes/tasks.ts`).
4. Status reports include `filesChanged` and issue summaries (`src/mcp/server.ts`, `src/brain/brain.ts`, `src/api/routes/status-reports.ts`) but are not merged into a unified searchable context timeline.
5. Task discussions (`src/api/routes/task-discussions.ts`) include client/source (`web|mail|mcp|cli`) and are valuable contextual signals, but currently separate from search.
6. A `search_index` FTS table exists (`src/db/index.ts`, migration 043), and `/api/search` exists (`src/api/routes/search.ts`), but there is no automatic indexing pipeline populating it from arm/task/discussion/status sources.
7. CLI activity currently depends on legacy SQLite `activity` table (`src/cli/commands/activity.ts`), while activity source of truth has moved to JetStream (`src/api/routes/activity.ts`).
8. Web activity page expects paginated activity response, but `/api/activity` currently returns only `activity` without pagination metadata (`src/web/src/pages/ActivityPage.tsx`, `src/api/routes/activity.ts`).

## Target Architecture

Use SQLite as system of record for durable context archive and searchable index. Keep JetStream for real-time/event transport.

### Data Model

Add migration(s) with these tables:

1. `arm_context_entries`
   - `id` (TEXT PK)
   - `arm_id` (TEXT, indexed)
   - `task_id` (TEXT nullable, indexed)
   - `session_id` (TEXT nullable, indexed)
   - `source` (TEXT: `arm_event|jetstream|task_comment|status_report|task_artifact|mail`)
   - `event_type` (TEXT, indexed)
   - `title` (TEXT)
   - `content` (TEXT)
   - `raw_payload` (TEXT JSON)
   - `created_at` (TEXT ISO, indexed)
2. `arm_context_commits`
   - `id` (INTEGER PK)
   - `entry_id` (TEXT FK -> `arm_context_entries.id`, indexed)
   - `commit_sha` (TEXT, indexed)
   - `repo_path` (TEXT)
3. `git_commit_cache`
   - `commit_sha` (TEXT PK)
   - `author_name` (TEXT)
   - `author_email` (TEXT)
   - `subject` (TEXT)
   - `body` (TEXT)
   - `committed_at` (TEXT, indexed)
   - `parent_shas` (TEXT JSON)
4. `arm_context_fts` (FTS5)
   - indexed fields from `arm_context_entries`: `title`, `content`, plus lightweight tokens for `arm_id`, `task_id`, `event_type`, `source`.

### Archival Strategy

1. Keep raw `arm_events` as short-horizon operational log.
2. Write normalized context records into `arm_context_entries` for long-term archive.
3. Add periodic cleanup job:
   - prune `arm_events` by configured retention (use existing `arm_events_retention_days`)
   - keep `arm_context_entries` by longer retention policy (default much longer; configurable)
4. Add optional compaction mode for very old `raw_payload` to reduce DB growth while preserving searchable text + dimensions.

## Ingestion Plan

### Ingestion Sources

1. Arm OpenCode event ingest hook
   - Extend existing handler in `src/api/server.ts` (where `arm_events` is inserted) to also enqueue/write normalized context entry.
2. Task completion artifacts
   - On task completion update path (`src/brain/brain.ts`), parse artifacts for commit SHA candidates and create `arm_context_entries` + `arm_context_commits`.
3. Status reports
   - On `/api/status-reports` create, write context entry with summary/issues/blockers/files changed.
4. Task discussions
   - On comment create/update in `src/api/routes/task-discussions.ts`, write context entry tagged by client and task.
5. Optional: mail processing outcomes
   - From `src/api/routes/mail.ts` tracking endpoint, index high-value decisions linked to task/arm.

### Commit Enrichment

1. Implement commit SHA extractor (strict regex for full/short SHA).
2. Resolve commit metadata via `git show --format` in API layer helper.
3. Cache commit metadata in `git_commit_cache` and link via `arm_context_commits`.
4. Allow commit-history filtering by commit and by parent/ancestry metadata (phase 2 enhancement).

## Query API Plan

Add dedicated context search route rather than overloading current `/api/search` until pipeline is stable.

1. New route group: `/api/context`
2. `POST /api/context/search`
   - body: `query`, `armIds[]`, `taskIds[]`, `commitShas[]`, `sources[]`, `eventTypes[]`, `from`, `to`, `limit`, `offset`, `sort`.
   - implementation: FTS match + relational filters + pagination + optional facet counts.
3. `GET /api/context/:entryId`
   - full entry payload + linked commit metadata.
4. `GET /api/context/facets`
   - distinct arm/task/source/type/commit counts for filter UIs.

Also add missing stored-events endpoint expected by MCP tooling:

5. `GET /api/arms/:id/stored-events` backed by `arm_events` (short horizon) with `since`, `type`, `limit`.

## CLI Plan

Add new command module:

1. `src/cli/commands/context.ts`
2. Commands:
   - `coleo context search --query "..."`
   - filters:
     - `--arm <id>` (repeatable)
     - `--task <id>` (repeatable)
     - `--commit <sha>` (repeatable)
     - `--from <iso>`
     - `--to <iso>`
     - `--source <source>`
     - `--type <eventType>`
   - output modes: table (default), `--json`
3. Register command in `src/cli/index.ts`.
4. Keep `activity` command for compatibility, but migrate implementation to API/JetStream-backed data and remove legacy `activity` table dependency.

## Web Plan

### API Client + Hooks

1. Extend `src/web/src/lib/api.ts` with context search methods and response types.
2. Add `useContextSearch` hook in `src/web/src/hooks`.
3. Add query keys in `src/web/src/lib/queryKeys.ts`.

### UI

1. New page: `src/web/src/pages/ContextPage.tsx`
   - search bar
   - filter chips/dropdowns for arm, task, commit, source, event type
   - date range controls
   - result list with snippets and badges
2. Add route + nav item (`src/web/src/App.tsx`, `src/web/src/components/Layout.tsx`).
3. Deep links:
   - From `TaskPage` to context filtered by task
   - From `ArmViewerPage` to context filtered by arm
4. Normalize Activity page contract:
   - either add pagination metadata to `/api/activity` or update page to not require it.

## Rollout Phases

### Phase 1: Schema + Ingestion Foundations

1. Add migrations for context tables and FTS.
2. Add ingest write path from arm events + status reports + task comments.
3. Add prune job for `arm_events`.

### Phase 2: Search API + Commit Linking

1. Implement `/api/context/search`.
2. Implement commit extraction + metadata cache.
3. Add `/api/arms/:id/stored-events`.

### Phase 3: CLI + Web Surfaces

1. Add CLI `context` command.
2. Add web context page with filters.
3. Add deep links from arm/task screens.

### Phase 4: Backfill + Hardening

1. Backfill existing `arm_events`, `status_reports`, `task_comments`, and completed-task artifacts into `arm_context_entries`.
2. Add observability counters for ingestion lag and index coverage.
3. Tune indexes and query plans with realistic dataset sizes.

## Testing Plan

1. Migration tests for new tables/FTS/triggers in `src/api/__tests__`.
2. Route tests:
   - context search filtering correctness for time/task/commit intersections
   - pagination determinism
3. Ingestion tests:
   - arm event -> context entry
   - status report -> context entry
   - task comment -> context entry
   - task artifacts commit extraction -> commit linkage
4. CLI tests for argument parsing and JSON output.
5. Web tests (hook + page state) for filter composition and API payload correctness.

## Risks and Mitigations

1. Dual event pipelines (JetStream + SQLite) can drift.
   - Mitigation: centralize context writes in API server ingest points and explicitly test idempotency.
2. Unbounded DB growth.
   - Mitigation: retention config + payload compaction + vacuum policy.
3. Commit metadata lookup cost.
   - Mitigation: cache table + lazy enrichment + bounded retries.
4. Existing search route confusion.
   - Mitigation: ship `/api/context/search` first, then converge old `/api/search` onto same index later.

## Proposed File Touch List (Implementation)

1. `src/db/index.ts` (new migrations)
2. `src/api/server.ts` (event ingest indexing hook)
3. `src/api/routes/context.ts` (new)
4. `src/api/routes/arms.ts` (stored-events endpoint)
5. `src/api/routes/index.ts` and `src/api/server.ts` (route wiring)
6. `src/cli/commands/context.ts` (new) and `src/cli/index.ts`
7. `src/web/src/lib/api.ts`
8. `src/web/src/hooks/useContextSearch.ts` (new)
9. `src/web/src/pages/ContextPage.tsx` (new)
10. `src/web/src/App.tsx` and `src/web/src/components/Layout.tsx`
11. Relevant tests under `src/api/__tests__`, CLI tests, and web tests

