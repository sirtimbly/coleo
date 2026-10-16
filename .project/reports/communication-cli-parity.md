# D3/D4 communication CLI parity

Source audit: `server/src/cli/commands/{mail,discoveries,discoveries-db,config,status-reports}.ts`
and corresponding `server/src/api/routes/` implementations. New commands target the selected API only.

| Original operation / defaults | Python replacement / API | Semantics and disposition |
| --- | --- | --- |
| `mail inbox -n 10 [-a]` | same; GET `/api/mail/inbox` | New then cur ordering; legacy `--all` produces the same bounded slice, not unlimited output. |
| `mail read [prefix]` | same; paginated inbox, GET detail, PATCH folder message flags | Latest by date without ID; exact ID preferred, ambiguous prefix rejected; full body retained; unseen becomes seen. Mark failure returns body and exit 2. |
| `mail send <message> [-s subject]` | same; POST `/api/mail/send` | human@local → brain@coleo.local, default `New task: <first 50 UTF-16 units>...`; internal sent queue, not external gateway. No legacy attachment option. |
| `discoveries list -l 20 [-p phase]` | same; paginated GET `/api/discoveries` | Open by default; phase/task filtering client-side over complete pages; full details. Additional status/arm/kind/severity/since filters. |
| `discoveries resolve <title> [-r resolved|dismissed] [--reason ...]` | same; GET list/detail then PATCH `/api/discoveries/:id` | Default reason `Manually resolved via CLI`; exact ID or literal case-insensitive title substring; ambiguity rejected rather than newest arbitrary match. Requires metadata-aware server change below. |
| `discoveries history -l 20` | same; complete resolved/dismissed API reads | Sort updatedAt descending before limit, full details and metadata/reasons. Older servers explicitly identify missing resolution metadata. |
| `discoveries summarize [-t task] [-v]` | retained operator diagnostic: legacy `coleo discoveries summarize` | Local DB + LLM diagnostic has no equivalent API job; client errors offline, no passthrough. Integrator must retain this diagnostic when cutting over. |
| `config arms` | same; GET `/api/config/arms` | API names/domain/harness/budget; server fallback domain is unknown rather than legacy general. |
| No old editing command | `config arms show NAME`, `import NAME FILE`, `delete NAME` | GET/PUT/DELETE `/api/config/arms/:name`; explicit local TOML import only; validate TOML and safe filename before write. PUT replaces whole config. |
| `status-reports backfill` with project/task/arm/dry-run flags | retained operator diagnostic: legacy `coleo status-reports backfill` | Server-local report filesystem/DB repair; existing report POST cannot preserve historical ID/date/idempotency; client errors offline. |
| No old listing/detail | `status-reports list`, `show ID` | GET collection/detail, task/arm/status/since filters and pagination; full report fields. |

All one-shot output has schemaVersion=1; Rich human output and JSON. Errors raise ValueError for the host CLI; partial read/mark results return 2. No retries or local server-state access. Existing named Inbox integration stays independent.

## Requested bounded parent integration

1. Dispatch first arguments `mail`, `discoveries`, `config`, `status-reports` to
   `await run_communication(args, api, stdout)` from `coleo_inbox.communication_cli`.
   Reserve names in host command catalog; dispatch help before connection/catalog validation.
2. Transport must support explicit keyword `method`, including PUT, PATCH and DELETE.
3. Discovery API: include parsed `metadata` (object, even when empty) in list/detail;
   PATCH accepts `reason`, `resolvedBy`, validates nonempty reason, preserves existing metadata,
   stores resolution_reason/resolved_by/resolved_at atomically with status and updated_at;
   return 404 for nonexistent ID. Client uses metadata presence as compatibility guard.
4. Preserve retained legacy summarizer/backfill registration until operator equivalents exist.

Offset pagination is complete for lookup/filter/history but cannot provide a snapshot under concurrent writes.
Status-report list server currently masks DB errors as empty results; fixing that server behavior is recommended.

## Verification

`uv run pytest clients/python/tests/test_communication_cli.py -q`: **33 passed**.
Tests use mocked actual envelopes and httpx MockTransport only, with no live mutations.
Coverage includes offline help and retained diagnostic flags; complete pagination and ambiguous
references; explicit PATCH/DELETE; older-server metadata rejection; full-body mark-read partial
failure; history ordering, filters, TOML validation and configuration credential redaction.
No shared registration, manifest, existing Python module, or TypeScript file was edited.
