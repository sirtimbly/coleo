# The signal desk: one socket does not mean one refresh policy

**September 29 disposition:** prioritize a unified Messaging collection API and
reliable recovery. Tab attention means unseen change in the particular view.
The [implementation plan](./implementation-plan.md) supplies the selected
semantics, delivery order, and acceptance checks for these findings.

**P2 — observed coordination gaps; recovery scenarios require browser validation.**

The guide requires every live subscription to use the projection provider.
`TasksPage`, `BugsPage`, `ArmsPage`, `ArmViewerPage`, and `DashboardPage` still call
`useWebSocket` directly. They nevertheless share one physical transport: do not
report this as a socket-per-panel bug.

The discrepancy is who decides what a signal means. The
[provider](../../../src/web/src/workbench/live-projections.tsx) invalidates
all task queries immediately, while [TasksPage](../../../src/web/src/pages/TasksPage.tsx)
also patches cached task rows and schedules some invalidations after 250 ms.
A single event can therefore activate both strategies. The provider's comment
about the narrowest cache invalidation is not accurate for task-wide and
workbench-wide invalidation. This is unnecessary work and makes refresh ordering
harder to reason about; request counts have not been benchmarked here.

## Recovery matters more than transport elegance

The [transport](../../../src/web/src/hooks/useWebSocket.ts) authenticates and
resubscribes after reconnecting. The provider handles messages, but does not
invalidate affected data on an authenticated reconnect. The
[server broadcast envelope](../../../src/api/websocket.ts) has a channel, event,
payload, and timestamp, with no resumable cursor protocol.

Concrete failure scenario: leave Processes open, lose only the WebSocket,
complete work while disconnected, then reconnect without changing browser
focus or connectivity. [ProcessesPage](../../../src/web/src/pages/ProcessesPage.tsx)
reloads on mount or matching signals, so the missed completion has no guaranteed
recovery trigger. Query-backed views have focus/network reconnect behavior,
but a WebSocket reconnect is a separate event. The configured
[query defaults](../../../src/web/src/lib/queryClient.ts) do not bridge it.
TanStack documents [focus/network refetching](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults);
inferring socket recovery from those defaults would be incorrect.

There are two more concrete coordination risks:

- Processes starts a new `listRuns` request for every matching signal, without
  serialization, cancellation, or a latest-response guard. An older response
  can overwrite a newer result if requests complete out of order.
- [MessagingPage](../../../src/web/src/pages/MessagingPage.tsx) resets a 200 ms
  trailing timer on every relevant signal. Sustained events faster than that
  can postpone refresh indefinitely. Once requests do run, its nine-source
  `Promise.all` refresh couples unrelated loading/failure states; most sources
  must all succeed before results are committed. Parallel requests are good,
  but they do not make those sources independent.

The existing [RefreshGate](../../../src/web/src/lib/refresh-gate.ts) prevents
overlap, but skips requests while one is active. Reusing it alone would not
guarantee a final refresh after the last event. A queued trailing refresh is
needed if events arriving during a fetch must be reflected.

## Backend choices and their frontend consequences

Keeping SQLite behind the API is appropriate for a product with one
authoritative project service and distributed workers. It avoids making every
Arm or browser a database replica. It does not establish horizontally
replicated API writers; that would need a separate ownership and deployment
decision. No database replacement is warranted by this frontend review.

The [NATS event store](../../../src/nats/event-store.ts) retains sequence-addressed
history. The [command stream](../../../src/nats/command-stream.ts) supplies a
publish ID, a finite duplicate window, and durable consumers with explicit
acknowledgments. These are useful service-side reliability mechanisms.
[NATS consumer documentation](https://docs.nats.io/learn/jetstream/pull-consumers)
describes acknowledgment and redelivery semantics. None of those mechanisms
automatically makes browser broadcasts durable or makes application mutations
exactly once. Do not advertise that guarantee.

For a lean product, prefer **snapshot plus change hints**: the API answers what
is true now; socket messages tell the browser when to ask again. Preserve
targeted cache patches where they are demonstrably useful. On reconnect,
refresh active projections. Only add cursor replay to the browser when a
measured interaction requires preserving every intermediate event. Keep event
history and sampled telemetry separate, as the docs already prescribe.

## Direction to choose

**Recommended: one refresh owner per resource and an explicit recovery event.**
Let Coleo policy map signals to a small plan such as affected query keys,
resource IDs, and attention hints. Keep that mapping pure; let a thin executor
perform cache changes and invoke local refresh controllers. The transport
should not import task and bug query policy. Use bounded coalescing: at most one
fetch in flight and one pending refresh. Avoid both unbounded storms and a
debounce that waits forever for silence.

**Alternative: keep page-owned synchronization.** Amend the provider-only rule
and require each page to define recovery, burst handling, and error behavior.
This saves migration effort but leaves more places to repair when event
contracts change. Merely moving every subscription into the provider does not
solve recovery or races.

Keep transient tab attention separate from durable Inbox read/resolved state.
Currently `clearAttention(["tasks"])` clears a channel globally, and the shell
maps routes to channels. Focusing one task panel therefore clears the signal
for other task panels too. Choose whether attention means “new work in this
channel” or “unseen change in this particular view”; a counter cannot represent
both. This coupling is documented, not changed.

## Proposed follow-up commits, only after selection

| Commit | Bounded change | Acceptance |
| --- | --- | --- |
| `fix(web): refresh active projections after socket recovery` | Expose authenticated recovery and refresh subscribed data | Disconnect only the socket; mutate server state; reconnect; all active affected views recover without focus changes |
| `fix(web): serialize projection refreshes with a trailing update` | Start with Processes, then Inbox; preserve valid data on failures | Reversed response order cannot regress UI; continuous events still refresh; last event eventually appears |
| `refactor(web): give task signals one cache update owner` | Consolidate the provider/page task policy without changing task semantics | One policy handles create/update/delete; live edits and burndown still update; request counts checked under a burst |

The first two are correctness work. Policy extraction is deferred coupling
work; it should follow the behavior tests, not precede them.
