# Shared terminal Inbox fixture server (contract v1)

From the repository root, with the checkout's Bun dependencies installed:

```sh
bun run e2e/support/terminal-bake-off/server.ts
# Optional strict authentication and a different port:
PORT=8092 API_KEY=bakeoff-secret bun run e2e/support/terminal-bake-off/server.ts

# Real localhost HTTP + two concurrent WebSocket client smoke tests:
bun test e2e/support/terminal-bake-off/server.test.ts
```

Default **HTTP origin `http://127.0.0.1:8091`**, API prefix `/api`, and
**WebSocket `ws://127.0.0.1:8091/ws`**. Configure both candidates with that origin
and API key `dev-terminal-bakeoff`. This default uses production's `dev-` auth
bypass; a non-`dev-` `API_KEY` enables real credential checks. HTTP credentials
use `X-API-Key`, not Bearer authorization. `/api/health` is public. Test controls
use the same HTTP authentication. The bind address is always loopback.

With the fixture running, both source-checkout clients use the same environment:

```sh
export COLEO_API_URL=http://127.0.0.1:8091
export COLEO_API_KEY=dev-terminal-bakeoff
bun run src/cli/index.ts inbox --facet messages --limit 5 --json
uv run --project experiments/inbox-python coleo-inbox --facet messages --limit 5 --json
bun run src/cli/index.ts inbox show thread:inbox:review --json
uv run --project experiments/inbox-python coleo-inbox show thread:inbox:review --json
```

Each launch creates a private temporary SQLite database (real migrations) and
Maildir. Ctrl+C/SIGTERM stops the listener and removes temporary storage. No
installed Coleo server, NATS, Python runtime, or real project mailbox is needed.
`startBakeoffServer({ port: 0, apiKey })` is also exported for ephemeral-port tests;
call the returned `stop()` for cleanup. The smoke suite exercises the server over
actual network sockets, rather than only Hono's in-process request adapter.

## Authoritative routes

This harness imports production handlers for:

- `GET /api/workbench/named-views`, `GET /api/workbench/named-views/inbox-triage?client=cli|tui|web`
  and `POST /api/workbench/named-views/resolve`.
- `GET /api/workbench/inbox?query=<URL-encoded JSON>&cursor=<opaque cursor>`.
  The query endpoint calls the production normalized collection loader with a
  fixed `asOf` and isolated retained-event dependency. The no-query legacy Inbox
  route also remains available.
- `GET /api/workbench/inbox/references/<URL-encoded @reference or full ID>` and
  `GET /api/workbench/inbox/records/<itemKey>`.
- `/api/mail/threads`, `/api/mail/threads/:id`,
  `/api/mail/threads/:id/messages/:messageId`, and the POST `selection` and
  `actions` subroutes. Also the production Inbox/sent/archive message reads,
  raw-mail reads and Inbox read/archive actions under `/api/mail`.
- `/api/workbench/attention` reads, `PUT /:itemKey`, and `POST /bulk`.

External delivery, gateway calls and Brain tracking return 405. Retained history
is intentionally a **healthy empty store**, not a connection to project NATS;
there are no event-detail fixtures. SQLite task/status records provide Brain
category/actionable content. Mail failures come from an actual unreadable Maildir
entry, so the normal partial-source and detail-503 paths are exercised.

For example, a production-valid normalized query can be as small as
`{"facet":"messages","mailbox":"inbox","limit":5}`; defaults are applied by
the server. Facets are `attention`, `messages`, `brain`, `arms`, `history`, `all`.
`mail` is a **scope**, not a facet. Query changes invalidate cursors. Named-view
resolution supplies the presentation, interaction definitions and inherited query
used by both clients; this harness does not freeze a duplicate of those definitions.

## Fixtures and determinism

`fixtures.json` is the versioned, language-neutral additional fixture/expected-count
manifest. It extends the existing production-test branching fixture
`src/workbench/examples/threaded-mail.ts`. The real server projection is the wire
contract, including hierarchy, compact references, revisions and response envelopes.

After reset:

- Six Inbox thread roots (page with limit 2 or 5); three sent roots; one archive root.
- `review` has five messages with nested API and terminal branches. Its API branch
  has two selectable messages. `review-terminal` is sent-only context.
- `handoff` is read; other roots cover unread/action-required states, long Unicode
  subjects, Markdown/code body content, and sent/archive navigation.
- Two blocked tasks and one needs-review status report; `release` has explicit
  requires-action attention. Searching for `no-such-fixture` gives healthy empty
  results; history also includes the durable records, but no retained events.

Fixture IDs, message dates, reply sequence, collection `asOf`, initial revisions
and paging are reproducible. Reset restores the same projected mail items/cursors.
Production mutation audit timestamps, WebSocket timestamps/pong clocks and file
metadata remain real-time; this is not a byte-for-byte frozen wall clock. HTTP
operations are serialized to avoid a read observing a half-completed reset/control.

## WebSocket contract and recovery

The server reuses `src/api/websocket.ts` handlers:

```json
{"type":"auth","apiKey":"dev-terminal-bakeoff"}
{"type":"subscribe","channel":"mail"}
{"type":"subscribe","channel":"workbench"}
{"type":"subscribe","channel":"activity"}
{"type":"subscribe","channel":"brain"}
{"type":"subscribe","channel":"tasks"}
{"type":"ping"}
```

Wait for `{"type":"auth","success":true}` before subscribing. The credential
field is **`apiKey`, not `token`**. Subscribe replies are
`{"type":"subscribed","channel":"mail"}`; unsubscribe uses the same channel
with type `unsubscribe`. `all` is supported. Ping receives
`{"type":"pong","timestamp":<epoch milliseconds>}`. Ping at least every 30s;
the server checks every 30s and closes connections whose last ping exceeds 60s.

Change hints have `{channel,event,data,timestamp}`. Real actions publish the real
`mail.read`, `mail.archived`, and `workbench.attention.*` events. Controls emit
`mail.received` invalidations; source toggles additionally emit an activity hint.
Hints are not snapshots or ordered/replayable event storage. On reconnect,
authenticate again, resubscribe, and HTTP-refresh the active query/detail. Both
candidates can remain connected simultaneously and see the same writes/hints.

## Fault controls

Send JSON to `POST /__test/control`. Unknown actions/fields and invalid values
return 400. `GET /__test/state` reports current outage flags, reply counter,
connected socket count and expected reset counts.

```sh
curl -sS http://127.0.0.1:8091/__test/control \
  -H 'Content-Type: application/json' -d '{"action":"reset"}'
```

For strict auth add `-H 'X-API-Key: bakeoff-secret'` to every control request.

| JSON body | Effect |
| --- | --- |
| `{"action":"reset"}` | Restore original Maildir/tasks/attention, clear both outages and reply numbering; invalidate connected clients. |
| `{"action":"source-outage","source":"mail","enabled":true}` | Make mail unavailable; collection is partial and thread detail returns 503. `source` defaults to `mail`. |
| `{"action":"source-outage","source":"mail","enabled":false}` | Restore original source contents, including previous writes/replies. |
| `{"action":"source-outage","source":"events","enabled":true}` | Make retained activity/history unavailable; false restores healthy empty history. |
| `{"action":"burst","count":50}` | Emit 50 mail hints, with no data mutation. Count defaults to 50, allowed 1–1000. |
| `{"action":"disconnect"}` | Close all current sockets with code 1012; HTTP stays available, reconnect is immediate. |
| `{"action":"add-reply"}` | Append an unread reply below `review-api`, incrementing deterministic ID/date. Existing selected IDs must not grow. |
| `{"action":"stale-revision"}` | Capture the current review revision, then append a reply; returns a ready-to-submit stale read command. |

Controls normally return `{ok:true,action,...}`. Both reply controls additionally
return `threadId`, `messageId`, `previousRevision`, `revision`, `staleAction`, and
`expectedStatus:409`. Submit `staleAction` verbatim to
`POST /api/mail/threads/review/actions`: the **actual production handler** rejects
it with 409. Reload detail, then explicitly choose the intended members and current
revision. Adding replies during a mail outage returns 409 until the source recovers.

For exact-selection testing, read current `/api/mail/threads/review`, then POST
`{revision,branchIds:["message:<review-api@example.test>"]}` to `/selection`.
The reset fixture returns two members. Reading a selection containing
`message:<review-terminal@example.test>` reports that member in `skippedMemberIds`
instead of mutating sent context. Collapsing a branch must preserve selection;
adding a reply must not extend it. Reset between each candidate's comparison run.

The deliberate 503 scenario logs an expected production error stack during smoke
tests. On Bun 1.3.14 the native stop promise can retain a stale WebSocket counter
after close callbacks; cleanup stops/unrefs the listener and drains tracked HTTP
handlers instead of waiting indefinitely for that counter.

## Verification evidence

On 2026-10-09, Bun 1.3.14: the network smoke suite passed 2 tests / 38 assertions,
covering both named-view clients, HTTP auth, pagination/reset determinism,
references, branch selection, exact writes/sent skips, both outage controls,
stale-revision 409, invalid inputs, two simultaneous sockets, heartbeat and
authenticated reconnect. The checkout TypeScript CLI and installed Python
candidate both exited 0 for the five-root JSON listing and independent review
thread `show`; both detail outputs contained the full root body.

Repository type checking reported no errors in this directory, but failed on
concurrent changes in `experiments/inbox-python/generate-fixtures.ts` and
`src/cli/tui/inbox/index.ts`. Interactive TUI rendering is evaluated separately
by the parent integration work.
