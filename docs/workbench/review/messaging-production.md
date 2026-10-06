# Connecting the shared Messaging models to the real Inbox

The HTML demo showed how one set of messages could appear in a web grid, nested
cards, a CLI snapshot, or a TUI list. This stage brings that work into Coleo's
actual React Inbox.

The main change is straightforward: **the API builds the Inbox list, and React
displays it.** The browser no longer fetches nine lists and tries to combine them
into one Inbox itself.

This page explains the implementation. The [threading contract](./threading-contract.md)
describes the shared rules for nested messages and selection in more detail.

## What changes in the app?

The workbench still has its two toolbar rows and its grid/card display choices.
Underneath those familiar controls, the data flow has changed:

| Before | Now |
| --- | --- |
| React fetched mail, reports, activity, events, and attention state separately. | React requests the current Inbox view once. The API gathers the required data. |
| The browser combined and filtered those lists. | The API applies the selected view, search, filters, and sort before returning a page. |
| A failed event request could look like an empty event list. | The response says which source failed. Previously loaded data can remain visible with a warning. |
| Reply indentation depended on the order of messages in an array. | Reply indentation follows the parent relationships returned by the API. |
| Several events could start competing refreshes or postpone refresh indefinitely. | One request controller decides when to fetch and prevents overlapping requests for the same view. |

The practical goal is that the browser, CLI, and TUI can ask for the same view and
receive the same meaning: which records belong in it, how messages relate, and
which IDs an action should target.

## How the API builds a view

The collection endpoint is still `GET /api/workbench/inbox`. A **collection** here
just means the list of items shown in the Inbox panel.

The browser sends a `query` describing what it wants. For example:

> Show Messages from the Inbox mailbox, search for “release”, newest first,
> with up to 100 conversations on the first page.

The API returns a `MessagingCollectionPage` containing:

- The matching top-level items.
- Reply relationships attached to each conversation.
- Counts for the requested view.
- Information about which data sources were successfully read.
- A token for requesting the next page, if there is one.

Messages views need mail and related conversation context. Brain and history
views need stored reports/records and event history. All and Needs attention can
include both. The API calls the underlying services directly; it does not make
HTTP requests back to its own endpoints.

Requests without the new `query` parameter still return the older stored-record
list during the transition. That compatibility matters when an older client is
running. It also means the API process must be restarted after installing these
changes: a new UI talking to an old API cannot use the new response format.

### What does “the same query” mean?

The shared code puts equivalent queries into one consistent form. For example,
extra spaces and capitalization in a case-insensitive search do not create
different cache entries. The API and browser calculate an identifier from that
form and use it to check that a response belongs to the requested view.

This prevents a slow request for All from replacing the results after the user
has already switched to Messages. It also lets two panels showing exactly the
same query share a fetched result while keeping their own display controls.

## Paging without losing conversations or older history

A conversation is one top-level item, even when it contains many messages. Its
replies stay attached to it rather than being split across unrelated Inbox pages.

For example, a page with 20 conversations can contain more than 20 messages. The
next page advances to the next conversation, not to a reply hidden inside one of
the first 20.

The API sorts top-level items by timestamp and then by ID. The ID is a tie-breaker
so two records with the same timestamp always have a predictable order.

The next-page token is called a **cursor**. Think of it as a bookmark that says:
“continue after this item, using these view settings.” The browser passes it back
without needing to understand its contents. Changing the search, mailbox, sort,
or other query settings starts a new traversal rather than reusing the bookmark
from a different list.

Event history adds one more concern: new events can arrive while the user is
loading older pages. The first request records which event sequence numbers were
available. Later pages use that same range, so new arrivals do not shift an
existing traversal. Refresh establishes a new range. If older events have expired
from storage, the API reports that the traversal needs to be restarted.

The current implementation scans the available event range to get timestamp
ordering right. The tests establish correctness, including history beyond 5,000
events; we still need to measure performance against large real event stores.

## A failed source is different from an empty result

The Inbox combines information from SQLite, Maildir, and the retained event
store. **Maildir** is the file-based mail store, with folders such as `new` and
`cur`. The **retained event store** holds recent operational history, such as
Brain activity and Arm events.

These stores can fail independently. For example, mail may be readable while
event history is temporarily unavailable.

The API therefore reports each source's status. A successful read with zero
matches can clear the old rows. A failed or timed-out read cannot prove that the
old rows are gone, so the client keeps previously loaded data and shows a warning.
Counts are labelled incomplete, and the client does not advance paging using a
partially read result.

The stores are also not frozen together at one exact instant. SQLite records and
read/resolve state are read together in a database transaction, but mail files and
events are read separately. The response describes what was read; it does not
claim every store represents the same millisecond.

## Refreshes have one place to run

`ProjectionController` is the shared code that manages reads for a view. Despite
the name, its job is ordinary request scheduling:

1. Allow only one fetch at a time for the same query.
2. Remember whether another refresh is needed while that fetch is running.
3. Run the follow-up fetch after the current one finishes.

Change notifications arrive over the existing WebSocket. They mean “the data may
have changed; fetch it again,” rather than supplying a complete replacement list.
The controller groups nearby notifications into a refresh. It starts the timer
from the first notification instead of restarting it on every event. This keeps
a busy stream from making the UI wait forever for a quiet moment.

When the socket reconnects and authenticates successfully, the app knows that it
may have missed changes. It refreshes active Messaging views without waiting for
a window-focus event or an Internet-connectivity event. Socket heartbeats and
metric samples do not cause Inbox reads.

During a read/archive action, intermediate change notifications are held for one
post-action refresh. That avoids reading mail repeatedly while the action is
moving files between folders.

A read that started before the action is cancelled and its result is ignored,
even if it finishes late. Search, view, mailbox, category, and sort controls are
temporarily disabled while the action finishes. That keeps the panel from starting
a competing query halfway through a write. The controls become available again
after the post-action read.

### Keeping an open card steady

Changing a query should not unnecessarily destroy cards that still match. While
the new request is pending, React can keep matching rows from the last result on
screen. That temporary display is not saved as the result of the new query.

When a successful response arrives, it replaces the displayed list. If the load
fails, the app keeps confirmed data and shows the error. With no data available,
it shows “Inbox unavailable,” not “Nothing in this view.”

We also fixed a specific React/Tabulator interaction: changing a clicked icon
could remove the original DOM element before Tabulator handled the click.
Tabulator then mistook it for a row click and collapsed the outer card. It now
checks the browser's recorded event path, which still identifies the original
control even if React has replaced its icon.

## Nested messages and selection

Expanded conversations show actual reply branches. The same shared hierarchy
model used by the demo decides which message is the parent of each reply.

The interaction rules are:

- Selecting a branch selects its loaded messages and descendants.
- Collapsing the branch hides those messages but does not deselect them.
- A partly selected branch shows a mixed checkbox.
- A new reply is not added to an existing selection automatically.
- Changing the query's search/view settings clears the selection. Sorting and
  refreshing preserve selected IDs that still exist.

The two toolbars keep their existing roles. Selection counts and clear controls
are in the secondary toolbar; read actions use the selected IDs when a selection
exists. Thread detail panels fetch their own full conversation and message bodies
rather than reloading the entire Inbox. Reply and archive remain available there.

The top button says **Mark selected read** when messages are selected. With no
selection, it reads the visible unread items. It is disabled while running so a
second click cannot start another batch.

## How read and archive actions avoid touching the wrong messages

The thread action endpoint is `POST /api/mail/threads/:id/actions`. The request
contains the selected message IDs, the action, and the thread's **revision**.

A revision is an identifier for the thread data the user saw. If a reply arrives
or the thread changes before the action runs, the API rejects the old revision
and asks the client to reload. It does not silently act on a different set of
messages.

Inbox messages can be marked read or archived. Sent messages shown as conversation
context are skipped. File operations use exact message IDs; a prefix match must
not accidentally pick a neighboring message.

Updating several mail files is not one all-or-nothing transaction. If the third
file operation fails after two succeed, those two changes have already happened.
The API reports the interruption and the view reloads before the user retries.

## Where to look in the code

| File | What it does |
| --- | --- |
| `src/api/messaging-collection.ts` | Gathers the required sources, applies the query, and returns a page. |
| `src/api/messaging-items.ts` | Converts source records into the shared Inbox item format. |
| `src/workbench/projection-controller.ts` | Schedules and serializes reads, including post-action refresh. |
| `src/web/src/workbench/use-messaging-collection.ts` | Connects that controller and shared data to React. |
| `src/web/src/pages/MessagingPage.tsx` | Composes the real Inbox controls, cards, selection, and actions. |
| `src/web/src/pages/MessagingThreadDetail.tsx` | Displays one complete conversation. |
| `src/web/src/workbench/MessagingThreadTree.tsx` | Displays nested replies and their selection controls. |

## What we have checked

The initial integration passed **100 focused tests / 484 assertions** and
**18 browser tests**, plus type checking, lint, and the production web build.
Those are the recorded results before the live-server and top-button follow-ups.

The checks cover older-page retrieval, query/response matching, source failures,
timeouts, request ordering, reconnects, thread/reply/archive flows, and keeping
expanded cards mounted through refreshes and Golden Layout splits.

Live use subsequently exposed two gaps: the UI could be running against an API
process that had not reloaded, and the top Mark Read button did not use the nested
selection. Both have follow-up fixes and checks:

- An older API response now produces restart guidance and an unavailable state,
  instead of a misleading query error or an empty Inbox.
- The top button uses the selected IDs. The browser regression selects two
  messages inside a larger conversation, checks the exact request, and confirms
  that unselected siblings and another conversation stay unread.
- Fast unit tests cover late reads, queued notifications, overlapping action
  holds, and completion of the post-action refresh.
- A normal mail-file move can be retried twice after the first attempt. Persistent
  missing-file errors stop after three attempts; permission failures stop
  immediately. Neither case is reported as an empty mailbox.

The latest targeted run passed **18 unit/API tests with 63 assertions** and the
single selected-read browser regression (about four seconds for the test itself).
Root TypeScript checking and web lint passed. The live API was reloaded and
confirmed to return the matching response format; the Inbox loaded without
warnings. A live no-op read of an already-read message succeeded and the view
settled without a stuck spinner. The exact unread-selection behavior is verified
with isolated browser data, so the live check did not change an unread message.

<details>
<summary>Commands for reproducing the focused checks</summary>

```sh
bun test src/workbench/__tests__/ src/api/__tests__/messaging-collection.test.ts \
  src/api/__tests__/workbench-inbox-pagination.test.ts src/api/__tests__/workbench-foundation.test.ts \
  src/api/__tests__/inbox-item-detail.test.ts src/api/__tests__/mail-threads.test.ts \
  src/api/__tests__/brain-swarm.test.ts src/mail/__tests__/maildir.test.ts \
  src/web/__tests__/websocket-reconnect.test.ts src/web/__tests__/refresh-gate.test.ts \
  src/web/__tests__/brain-activity.test.ts src/scripts/__tests__/workbench-demo-report.test.ts
bun run test:e2e:web e2e/inbox.spec.ts e2e/inbox-item-detail.spec.ts \
  e2e/inbox-stability.spec.ts e2e/messaging-recovery.spec.ts
bun run typecheck
bun run --cwd src/web lint
bun run web:build
```

</details>

## What comes next?

The next portability step is to let clients load a named view through the API,
then add a real CLI snapshot command and the live TUI view. That tests whether the
same view definition works outside React.

The [accepted plan](./implementation-plan.md) separately tracks independent panel
settings, panel-specific notification dots, and the complete toolbar/blueprint
editor. Those are later steps, not features supplied by this Inbox integration.
