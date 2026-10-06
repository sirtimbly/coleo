# Nested resource groups and mail threading

This extends the [Messaging contract](./messaging-contract.md) and the
[implementation plan](./implementation-plan.md) with the relationship semantics
demonstrated in the [HTML report](/workbench-report.html).

## Three independent pieces of state

1. **Relationships:** a versioned, serializable primary-parent forest. Each node
   has a stable ID, parent ID, group/resource kind, selectable flag, data, and
   `childrenComplete`. Root and sibling order comes from the source projection.
2. **Visibility and focus:** expanded node IDs and the focused node belong to the
   live client/view. Closing a branch hides its descendants; reopening restores
   their previous expansion. Keyboard navigation uses visible parent-first rows.
3. **Selection:** an explicit set of loaded, selectable node IDs. Virtual thread
   headers organize members but are not themselves message mutation targets.

The reusable model is `src/workbench/resource-hierarchy.ts`. Its indexes,
visibility projection, subtree traversal, and selection summaries are headless.
They reject duplicate IDs, missing containment parents, inconsistent roots, and
cycles. Iterative traversal is covered with a 10,000-node deep-tree fixture.

## Selection and filtering rules

- Selecting a branch includes its selectable message and loaded descendants.
  Selecting a conversation header includes all loaded messages in that thread.
  Selecting one message is a separate operation.
- Overlapping branches deduplicate member IDs. Ancestors have none/mixed/all
  summaries derived from their loaded members, plus a separate completeness flag.
- Collapse never clears selection. Clients display how many selected members are
  hidden. Presentation changes, sorting, and client switches preserve membership.
- An arriving reply gets a new ID and is not selected automatically. A previously
  fully selected branch becomes mixed. Selecting that branch again deliberately
  includes the newly loaded member.
- Changing query scope/search/filter clears the demo's selection. Search retains
  matching descendants' ancestor context; it does not silently change expansion.
  An ancestor can therefore remain collapsed while containing a matching reply.
- Selection refers to loaded IDs, not all future messages, all matching server
  records, or unknown children. Incomplete child coverage is explicit. Expansion
  and selection never authorize a command.

`src/workbench/message-hierarchy.ts` materializes thread members underneath
collection roots. Collection paging and query counts stay root-based; replies
are attached context, not independent list pages. A stale thread summary retains
its whole attached hierarchy through `reconcileMessagingPage`. An authoritative
empty replacement removes the hierarchy and its now-absent selection members.

## Source-owned mail relationships

`src/workbench/mail-thread-model.ts` groups conversations and creates actual
reply parents using Message-ID, In-Reply-To, References, and explicit Coleo
thread/task/bug/request headers. The result does not depend on enumeration order
or adjacency in a sorted array. Replies retain sent/inbox/archive context.

Message node identity is canonical Message-ID, with a storage-ID fallback.
Copies of one message have one node with explicit mailbox/storage locations.
Conversation group IDs include the view mailbox; actual message IDs remain
stable across mailbox contexts. Subjects label threads and do not merge unrelated
identified conversations. Missing direct parents are diagnosed; a nearest loaded
reference or thread header supplies containment context. Malformed reply cycles
are detached deterministically with a diagnostic, rather than producing an
infinite UI traversal or inventing a message.

Completeness describes the enumerated local snapshot and loaded children. It is
not a promise that external ancestors or future replies exist in local Maildir.
Mailbox unread counts are distinct from the unread flags of related messages
displayed from other mailboxes.

## API surface

These routes are mounted under the existing authenticated `/api/mail` router:

| Route | Result |
| --- | --- |
| `GET /api/mail/threads?mailbox=inbox&search=...&limit=50&offset=0` | Versioned conversation projections, hierarchy nodes, diagnostics, revisions, root paging, and query-scoped counts. |
| `GET /api/mail/threads/:id?mailbox=inbox` | The selected conversation's loaded nested context, including related sent messages. |
| `GET /api/mail/threads/:id/messages/:messageId?mailbox=inbox` | Exact message identity and full body in that thread, including sent context. The Message-ID URL parameter must be encoded. |
| `POST /api/mail/threads/:id/selection` | Read-only, revision-guarded resolution of branch IDs into explicit loaded member IDs and eligible Inbox storage IDs. |

Example selection request:

```json
{
  "mailbox": "inbox",
  "revision": "<revision returned by the thread API>",
  "branchIds": ["message:<review-api@example.test>"]
}
```

The response declares `scope: "loaded-descendants"`. Unknown/foreign branches
are rejected; a changed revision returns HTTP 409 and requires reload. This
endpoint does not mark messages read or persist a selection. Actual mutations
still use API-owned domain operations and their authorization/validation rules.

`src/api/mail-thread-projection.ts` reads domain Maildir directly and hashes the
projected snapshot. Related mailbox context is loaded to reconstruct replies;
counts distinguish requested-mailbox messages from conversation-context messages.
It does not claim an atomic Maildir snapshot. New thread reads opt into strict
Maildir error handling: missing, unconfigured folders are empty, while failed
enumeration/reads return unavailable (HTTP 503), not a misleading empty result.
Existing callers retain their default Maildir behavior.

## Blueprint and demo mappings

`src/workbench/examples/threaded-inbox.json` defines `inbox-thread-review` with
`hierarchy.initialExpansion` and `hierarchy.selectionScope`, plus the registered
`collection.hierarchy` control. These configure the same two toolbars, optional
metadata region, and resource renderer hierarchy already in the plan.

- **Browser:** indented tree grid, nested cards, and a custom reply-tree adapter;
  per-branch toggles and tri-state checkboxes, plus an individual-message toggle.
- **CLI preview:** tree text and structured JSON with parent IDs, coverage,
  expanded/visible IDs, and selected-member snapshots. Group-target argument
  controls let the webpage exercise visibility and membership directly.
- **TUI preview:** j/k moves focus, right/left opens/closes branches or moves to
  parent/child, Space toggles loaded branch membership, Shift+Space toggles the
  focused message, and Enter inspects its semantic detail reference.

The report creates a temporary Maildir and uses the actual thread routes to
obtain two conversations/eight messages and a verified two-member API branch
selection. The local Add reply action demonstrates snapshot selection; it does
not write live mail. The HTML clients remain demo adapters, with native terminal
and application-wide integration following the accepted plan.

## Evidence

- Report generation passes **85 focused tests, 435 assertions**, including the
  existing Maildir tests and new hierarchy, threading, snapshot, and API tests.
- Root and isolated browser TypeScript checking pass during generation.
- Browser checks exercise nested selection, hidden selected counts, CLI group
  controls/JSON, TUI keyboard folding and individual/branch selection, cross-client
  state, arriving replies, source outages, and nested-card presentation.
- Desktop and 390px mobile layouts were inspected; document width stays within
  the viewport. Accessibility and best-practices snapshot checks score 100.

The [production Messaging integration](./messaging-production.md) subsequently
connects these models to the mixed-source collection endpoint and the actual
React Inbox refresh owner. The evidence above remains the threading/demo slice's
record; the integration has separate API/model/browser checks.
