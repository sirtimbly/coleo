# D1/D2 remote Python CLI parity

Source review: `server/src/cli/commands/{arm,agent,status,activity,activity-api,activity-types,activity-formatters,activity-printers}.ts` and corresponding API routes (2026-10-16).

All target commands below are relative to `coleo-client`; `arm` and `arms` are aliases. Runtime data and writes use the selected API only. No mutations are retried. One-shot JSON is an object with `schemaVersion: 1`, `kind`, and the server response fields; errors propagate to the parent CLI. Bulk/partially completed operations return 2 with explicit results. Argument failures return through `ValueError` before HTTP.

| Legacy command | Flags/defaults and source/side effects | Python target / endpoint | Parity decision |
| --- | --- | --- | --- |
| arm list | all, once, interval=2000ms; API; TTY live default | arms list; GET /api/arms | Explicit --watch for live snapshots; one-shot default; --all includes stopped (server includeAll alone does not hide them) |
| arm status | ID; API runtime detail | arms status/show ID; GET /api/arms/:id | Full server detail retained |
| arm names | count=10, stats; pure random suggestions | arms names | Pure offline generator; no filesystem or DB; suggestions are not reservations |
| arm spawn | name, workdir=local cwd, prompt, harness, provider, model, template, recover, watch; create then spawn | arms spawn; GET /api/arms, POST /api/arms, POST /api/arms/:id/spawn | Noninteractive; remote workdir omitted uses server defaults, never local expansion; supports --agent/--agent-id; create/spawn partial failure retained and identified; no rollback/retry |
| arm kill | ID; API with local fallback | arms kill ID; POST /api/arms/:id/kill | API only |
| arm prompt | ID, message, interrupt | arms prompt ID MESSAGE; POST /api/arms/:id/prompt | Blank prompts rejected; interrupt preserved |
| arm todos | ID; API | arms todos ID; GET /api/arms/:id/todos | Full todos, including API-level errors |
| arm recover | ID; API | arms recover ID; POST /api/arms/:id/recover | Server owns recovery |
| arm remove | ID; stopped precheck, DELETE | arms remove ID; GET + DELETE /api/arms/:id | Stopped precheck preserved; server deletion currently has no atomic stopped guard |
| arm cleanup | list then DELETE stopped; legacy does not report failure exit | arms cleanup; GET /api/arms?includeAll=true + detail/DELETE | Per-arm success/error; partial exit 2 |
| arm tail | optional ID, all, filter; WebSocket | arms tail; GET /api/activity/transcript | Serial bounded polling; persisted transcript events, not every transient WebSocket event |
| arm watch | ID, no-tools, no-system, history=2, verbose; API polling | arms watch; GET /api/arms/:id/messages | Bounded 200-message windows; changed messages re-emitted; session-aware dedup; verbose exposes snapshot metadata |
| (new) arm messages/transcript | bounded conversation/history | arms messages / transcript ID | Messages API and filtered transcript API |
| arm logs | local log file and tail subprocess | intentionally unsupported | Error directs to arm watch/tail for API observations; local process logs belong to host operator |
| agent status | connected agents via API | agents [list/status]; GET /api/agents | No fabricated active-arm count (list API does not return it) |
| (new) agent detail/arms | API | agents show ID / arms ID; GET /api/agents/:id[/arms] | Encoded IDs |
| agent start | local host daemon | coleo-agent run | Parent/operator track; not a remote command |
| status | API plus local files/PID/maildir fallback | status; GET /api/status | Selected server only |
| activity list | count=20 max 200, actor; API | activity list; GET /api/activity | Adds producer, before-sequence, pages; cursor pagination only available with producer |
| activity transcript | count=100 max 1000, arm, host, project, since, until | activity transcript; GET /api/activity/transcript | Oldest-first; preserves pagination/filters; bounded result; JSON changes from legacy array to versioned object |
| activity search | query, count=20 max100, arm, host, project, min-score=.05; semantic | activity search; POST /api/search | Multiple arms searched independently then merged/ranked, avoiding legacy post-filter loss |
| activity tail | count=10, arm, host, project, interval-ms=2000 | activity tail; GET /api/activity/transcript | Sequence-cursor paging where supported; timestamp fallback on older servers; cancellation propagated to parent |

## Streaming contract and API limits

`--json` on watch/tail emits JSONL: one versioned object per event, message update, snapshot, or stream notice. `kind` identifies the record; `record` holds the data. Message updates include `armId` and `sessionId`; consumers should upsert by session/message ID. `--polls N` bounds polling for automation, `--once` is one poll; otherwise Ctrl+C cancels. Polls never overlap. Text output uses Rich without interpreting server strings as markup.

New servers support sequence-cursor transcript paging (contract below). Older servers still have only timestamp overlap: equal-time identical entries cannot be distinguished without event sequence. A full window with no cursor progress stops with a partial-result notice instead of skipping data. The old reader may scan only 5000 events and emits no durable next cursor. Messages still have no older-page cursor; watch detects nonoverlapping full windows and reports a gap. GET messages may trigger recovery inside the existing server route.

### Transcript API cursor contract

`GET /api/activity/transcript?afterSequence=0` opts into `pagination.cursorMode: "sequence-v1"`. Zero starts currently retained history. Subsequent requests send the returned `pagination.nextCursor` as `afterSequence`, with the same arm/host/project/since/until filters. This is an **exclusive canonical JetStream position**, not an event timestamp or a client-invented ordinal. The existing store's `getEvent(sequence)` resolves the actual JetStream position; no store/schema changes were needed.

- Opt-in rows have `sequence` and are returned in stream sequence order (`order: "sequence-asc"`), even for tied/late timestamps. Cursor mode selects project-scoped arm-associated events with nonempty `event.armId`; direct stream lookup has no subject metadata. Default legacy mode retains its existing arm-subject query and timestamp ordering, with additive `sequence` fields.
- The page captures `highWatermark` and scans at most `scanLimit` stream positions (existing default `max(limit * 5, 500)`, maximum 5000), with at most 16 direct reads outstanding. This trades bounded direct-read cost for correct continuation without changing the event-store interface. Prefetched positions after a filled result page are not acknowledged and are read again on the next page.
- `nextCursor` includes inspected filtered-out positions, allowing empty filtered pages to make progress. `hasMore` and `truncated` mean unscanned positions remain up to the captured high watermark, **not** that more filter matches are guaranteed. `truncationReason` is `result-limit`, `scan-limit`, or null. `scannedSequences` counts inspected/acknowledged positions.
- `gap` is `retention`, `missing-sequences`, or `cursor-ahead-of-stream` when continuity cannot be guaranteed; the client reports a partial result and stops. Missing/deleted positions are counted even if their previous filter membership cannot be determined. Stream recreation which reuses positions beyond the old cursor cannot be detected without a stream incarnation identifier (not exposed by the current store).
- Default legacy `hasMore` remains compatible; additive `truncated: null` explicitly means its old bounded reader cannot prove exhaustion, while known response-limit truncation is true. Default metadata advertises `cursorSupported: true`.
- Python probes with `afterSequence=0`, recognizes only the explicit cursor mode, preserves sequence order and duplicate-content events, and resumes by cursor. Old servers ignore the parameter, triggering the existing bounded timestamp fallback. A server losing cursor support mid-stream is an error, never a silent rewind. Polls remain serial, bounded, and cancellable.

## Integration and verification

Parent dispatch calls `await run_remote(argv, api, stdout)` from `coleo_inbox.remote_cli`; argv starts with `arm`, `arms`, `agents`, `activity`, or `status`. Parent owns transport lifecycle, `ValueError` rendering/status 1, and cancellation/status 130. Transport must support `request(path, body=None, params=None, *, method=None)` (DELETE used by remove/cleanup).

Owned Python suite: `uv run pytest clients/python/tests/test_remote_cli.py -q` — 54 passed. All HTTP is `httpx.MockTransport`; no live server or runtime files touched. Coverage includes invalid arguments before requests, help, path encoding, create/spawn partial failures and write counts, selected-host payloads, stopped-state checks/DELETE failures, Rich escaping, activity cursor paging/repetition, transcript filters/ordering/overlap/saturation, message updates/session changes/gaps, cancellation, multi-arm semantic search, sequence ties/late timestamps/empty scans, malformed cursor contracts, old-server fallback, and refusal to silently downgrade a live cursor stream.

API verification: `bun test server/src/api/__tests__/activity-transcript-cursor.test.ts server/src/api/__tests__/activity-transcript.test.ts` — 15 passed (9 new cursor tests). New tests use actual `InMemoryEventStore` events and in-memory SQLite/Hono routes; retention/deletion/read-failure cases use narrowly overridden store methods. `bun run typecheck` passed. No live service mutations or commits.
