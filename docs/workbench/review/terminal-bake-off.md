# Inbox terminal bake-off: TypeScript/OpenTUI vs Python/Rich + Textual

**Requested by Tim on 2026-10-09. Status: concluded; Python/Rich + Textual selected.**

This document is retained as the historical comparison contract and evidence
record. Tim's hands-on conclusion is that the Python/Textual candidate is
substantially better looking and more feature-full for the intended terminal
client, so it is the selected direction. This qualitative product decision does
not imply an objective scorecard was completed. The active migration direction
is recorded in the [implementation plan](./implementation-plan.md).

The former evaluation guide remains available for reproducibility. Start with the
[hands-on testing guide and codebase tour](./terminal-bake-off-review.md) for
commands, verification evidence, explicit fallbacks, and the human review checkpoint.

## Original goal and comparison contract

Build two usable implementations of the same Inbox workflow:

1. Refine the existing TypeScript CLI and build a live Inbox TUI with OpenTUI.
2. Create an isolated Python project using Rich for CLI output and Textual for
   its live Inbox TUI.
3. Give Tim runnable commands and an equivalent test script for both.
4. After hands-on testing, give a codebase tour and compare maintenance costs.

The question is whether TypeScript can deliver the desired terminal experience
with a small, understandable application layer, or whether Rich/Textual's built-in
rendering, widgets, and conventions justify a Python terminal client. A preference
for TypeScript is a decision input, not permission to accept a worse interface.
Neither framework wins automatically because it needs fewer lines in a demo.

At the time, this was the next workbench milestone, replacing the single-track execution of
1e until the comparison is complete. Keep the existing browser and service
contracts as the common reference. Do not migrate Tasks/Bugs or retire either
candidate before Tim has tested them and chosen a direction.

## What already exists

- `src/cli/commands/inbox.ts`: one-shot command dispatch and exit statuses.
- `src/cli/inbox/`: API transport, resolved flags/help, paging, exact selection
  actions, references, and custom text rendering.
- `src/cli/inbox/ink.ts`: our own ANSI helper, **not the Ink package**. Rename or
  replace it during the TypeScript refinement so this distinction is unambiguous.
- `src/cli/tui/arms-dashboard.ts`: an existing imperative OpenTUI application.
  It is a useful integration reference, not a template to copy into another large file.
- `src/workbench/`: named views, interaction definitions, query normalization,
  reply hierarchy, metadata, freshness, and refresh scheduling.
- `src/api/routes/workbench-named-views.ts`, `workbench-inbox.ts`, and
  `mail-threads.ts`: authoritative definitions, collection/detail reads and actions.

The existing TypeScript CLI is the behavioral baseline, but its hand-drawn ANSI
tables/cards/timeline are provisional. We should preserve useful domain and API
logic while replacing terminal machinery with library-owned behavior.

## Shared requirements: the comparison contract

### Service and data boundaries

Both clients use the same Coleo API, named `inbox-triage` view, authentication,
query, detail-reference, thread-revision, and command contracts. Neither reads
SQLite, Maildir, or JetStream directly. Python must work without invoking the
TypeScript CLI as its runtime backend.

Use HTTP snapshots plus Coleo's authenticated change/recovery protocol for live
updates. Hints invalidate relevant queries; they do not become an alternative
resource store. No cross-store atomic-snapshot claims. Source freshness, partial
coverage, and unknown counts must remain explicit.

Share versioned JSON fixtures and expected outcomes for both languages. These
cover named views, normalized queries, response envelopes, hierarchy, references,
commands, invalid inputs, and event/recovery sequences. Python implements only
the client-side semantics it needs; it does not reimplement server projection or
mail-thread grouping. Publish a service schema/fixture boundary where the current
contract exists only as TypeScript types, with validation against actual API output.

### CLI parity

Both candidates must provide:

- Named-view resolution, definition-driven flags/aliases and help; inherited
  filters, profile, mailbox/category transitions, sort, limit, and paging.
- Readable default table output: short stable references, useful subjects,
  understandable states/times, sensible column sizing, and no accidental wrapping.
- Visibly distinct Grid, Cards and Timeline presentations. Use terminal-native
  panels/tables/styled text and declare fallbacks consistently. Share content and
  meaning, not an identical glyph-by-glyph output requirement.
- Reply trees, expansion choices, optional metadata, partial-source diagnostics,
  full structured JSON, and the existing exit status contract (0/1/2).
- `show <ref>` independent of listing filters or pagination; full message bodies
  displayed readably in text mode rather than as a raw JSON envelope.
- Explicit `mark-read` selection, loaded-branch selection, revision checks,
  skipped sent-context reporting, partial write results, and post-action refresh.
- Terminal-width handling, Unicode, color capability handling, `NO_COLOR`,
  explicit color override, clean piping, and undecorated JSON.
- One-shot exit without starting a live transport or leaving terminal modes altered.

Keep command names and view-derived flags equivalent. A different executable
prefix is expected. Do not promise that an installed `coleo` binary reflects this
checkout; document source-checkout commands as well as packaging commands.

### TUI parity

Each TUI must implement:

- A live Inbox collection with search, facet, mailbox, Brain category, sort,
  refresh, load-more, and source/connection feedback.
- List/detail navigation with full message content, readable Markdown where
  supported, and reply ancestry retained during search and inspection.
- Expand/collapse, focus distinct from selection, individual and loaded-branch
  selection, visible selected counts, and explicit read actions.
- Collapse preserves selection; new replies remain unselected; changing query
  scope resets selection; stale revisions cannot silently act on new members.
- Grid and card/list presentations plus a timeline presentation or a clearly
  declared fallback. The CLI and TUI share content recipes within each candidate
  where that is natural; do not simulate a TUI by repeatedly printing CLI strings.
- Shared operation IDs and consistent web/TUI key intent, generated help, active
  panel/toggle feedback, scoped keys, and normal text-input behavior. Record any
  terminal-protocol limitations rather than silently ignoring bindings.
- Responsive layouts: a useful split at wide sizes, a list/detail switch at narrow
  sizes, and access to secondary actions without more than two toolbar/header rows.
- Ordered refresh, bounded event-burst updates, obsolete-response protection,
  authenticated socket-only reconnect recovery, and labeled retained partial data.
- Clean shutdown on normal quit, Ctrl+C, and handled failures; terminal restoration.

## Phase A — Freeze the fixture contract and evaluation harness

**Outputs:** `e2e/support/terminal-bake-off/` (shared JSON fixtures and scenarios),
a documented fixture-server command, and a capability/acceptance checklist.

1. Inventory the current HTTP/WebSocket wire messages and actual auth lifecycle.
   Specify how both TUIs subscribe, reconnect, and refresh active queries.
2. Extract a small shared fixture set from existing Messaging/thread tests: long
   subjects, Unicode, multiple mailboxes, branching replies, sent-only context,
   read/action states, empty/partial results, and cursor boundaries.
3. Provide a deterministic local HTTP/WebSocket fixture service using existing
   API/service test patterns. Include controls to pause a source, emit a burst,
   disconnect just the socket, add a reply, and reject a stale revision.
4. Add shared expected query/selection/exit outcomes. Validate both fixture schemas
   and the real API responses; do not let mocks define a competing protocol.
5. Record a baseline of current CLI examples and the existing OpenTUI dependency,
   packaging requirements, and supported target environments.

**Exit:** fixtures can be exercised without touching real project messages; both
candidates have the same published input/output expectations and fault scenarios.

## Historical Phase B — Refine the TypeScript CLI and select the OpenTUI integration

**Outputs:** a library-backed CLI renderer and a bounded OpenTUI compatibility
assessment recorded alongside the code.

1. Evaluate a pinned OpenTUI release against our Bun version and existing Arms
   dashboard. Current upstream docs may describe APIs newer than the installed
   `0.1.107`; verify actual APIs before coding. Keep upgrade changes explicit and
   run the affected existing terminal checks.
2. Prove a minimal one-shot rendering path: table, panel, styled text, tree,
   pipe/plain output, exit, and cleanup. Check whether OpenTUI can own this without
   forcing interactive screen/input modes on ordinary CLI output.
3. Prefer library layout/styling/renderables for shared CLI/TUI components. If
   OpenTUI is unsuitable for one-shot output, select established TypeScript output
   libraries for that role and record the resulting split as a comparison cost.
   Do not conceal a custom ANSI renderer behind a generic adapter name.
4. Replace hand-authored escape sequences and manual border/wrapping machinery
   where the selected library provides them. Retain Coleo-specific formatting
   policy, not a home-grown terminal engine. Do not adopt the Ink framework by
   implication; any additional framework choice must be explained in the assessment.
5. Refine `show` text output into readable headers/body/thread content. Keep the
   JSON interface and API behavior stable.
6. Organize presentation into reusable collection rows, message panels, metadata,
   source-status and command-help components with a shared theme.

**Exit:** the existing CLI workflow is at least as readable as the current output,
uses the selected library primitives, passes the CLI contract, and leaves behind
a documented, honest answer about what is reusable in the TUI.

## Historical Phase C — Build the TypeScript/OpenTUI Inbox TUI

**Proposed entry:** `coleo inbox tui [view/query options]`. Register `tui` as a
host command and validate collisions with named commands.

**Suggested structure:** `src/cli/tui/inbox/` with separate session/controller,
transport, components, theme, and bindings modules. Reuse `src/workbench/` and the
CLI transport/domain helpers rather than duplicating Inbox projection logic.

1. Choose Core or a supported React/Solid adapter based on real component coverage
   and maintainability. Document the choice; do not mix frameworks unnecessarily.
2. Implement collection/detail composition, filtering and paging, then hierarchy
   and exact selection/actions. Avoid putting transport ownership inside row widgets.
3. Adapt the existing headless refresh controller to HTTP plus live hints. Exercise
   disconnect/reconnect and mutation holds before adding polish.
4. Evaluate `@opentui/keymap` as an execution backend for the shared interaction
   definitions. Preserve our serializable operation schema and command authority;
   do not create a second user-facing binding definition.
5. Add responsive behavior, accessible help text, active states, themes, focus
   restoration, and explicit unsupported-capability feedback.
6. Test resize, terminal restoration, Unicode and long content with a small PTY
   smoke suite and deterministic library-level tests. Use realistic loaded lists
   to expose scrolling and rerender problems, without claiming broad benchmarks.

**Exit:** the TypeScript CLI and TUI satisfy the shared checklist, can be launched
from the checkout, and are ready for Tim's first hands-on preview.

## Historical Phase D — Create the isolated Python candidate

**Original comparison directory:** `experiments/inbox-python/`. The selected
production client is intended to become a root-level Python project as part of
the staged monorepo migration; do not treat the experiment path as the target.

**Proposed tooling:** `pyproject.toml`, `uv.lock`, a `src/coleo_inbox/` package,
pytest-based tests, Rich, Textual, and explicit HTTP/WebSocket dependencies chosen
after protocol review. Pin a supported Python version and dependency versions.
No root Python conversion and no Python requirement for running the TS candidate.

Suggested package boundaries:

```text
experiments/inbox-python/
  pyproject.toml
  uv.lock
  README.md
  src/coleo_inbox/
    cli.py              # command dispatch and definition-driven flags
    contracts.py        # wire validation and typed values
    api.py              # HTTP/auth and reference/detail commands
    session.py          # live hints, reconnect, ordered query lifecycle
    selection.py        # explicit loaded IDs and branch semantics
    presentation.py     # shared Rich renderables and theme
    app.py              # Textual composition and screen lifecycle
    widgets/            # thin Inbox-specific widget compositions
  tests/
```

1. Implement API and contract handling against the same fixtures. Use Python's
   normal dependency/runtime tools; no subprocess bridge to TS business logic.
2. Build the CLI with Rich Table/Panel/Text/Tree/Markdown primitives, matching
   flags, references, metadata, JSON, exits and action semantics.
3. Build the TUI with Textual's existing widgets/layout/themes/testing facilities.
   Use Rich renderables where appropriate, but use native interactive widgets for
   focus, scrolling, tables and trees instead of faking interactivity.
4. Consume the API-resolved interaction model and expose the same keyboard intent.
   Port the necessary refresh/selection state behavior with shared conformance
   fixtures; measure how much additional language-specific logic is required.
5. Implement both CLI and TUI parity before comparing visual polish. Track built-in
   versus custom functionality and any unsupported requirements explicitly.

**Proposed entry:** `uv run --project experiments/inbox-python coleo-inbox ...`,
with `tui` selecting the interactive interface. Confirm final launch syntax in
the delivered README rather than treating these proposed commands as available now.

**Exit:** Python CLI and TUI pass the same scenario checklist and run independently
against the fixture server and live Coleo API.

## Historical Phase E — Package both for Tim's hands-on evaluation

Deliver a single comparison README with copy/paste setup and launch commands for
all four experiences. Include dependency versions, fixture-server lifecycle,
live-API configuration, key cheat sheets, and known limitations. No unpublished
global install should be necessary.

Ask Tim to run this sequence in both stacks:

1. Print the same five-message grid, cards, timeline, and folded/unfolded reply tree.
2. Resize/narrow output and inspect a long Unicode subject. Pipe JSON and disable color.
3. Copy a compact reference into `show` without repeating filters; inspect full body.
4. Open the TUI; search, change mailbox/category, page older roots, open and return
   from detail using the keyboard.
5. Fold a selected branch, add a fixture reply, and verify selected IDs do not grow.
6. Run a read action on fixture messages; verify exact targets and refreshed state.
7. Trigger a source outage, a burst, and a socket-only disconnect; observe recovery.
8. Narrow to a single-pane layout, return to a split, then quit and check the shell.

Record observations for visual quality, discoverability, keyboard predictability,
responsiveness, and bugs. Both stacks get the same opportunity to address obvious
defects. Use fixtures for writes unless Tim explicitly chooses a real message.

**Historical human checkpoint:** Tim has now selected Python/Rich + Textual.
The Inbox-specific OpenTUI candidate has since been removed by explicit
direction; the Bun snapshot CLI remains until Python parity and its deprecation
gates in the implementation plan are met. Do not remove unrelated terminal clients.

## Historical Phase F — Guided codebase tour and comparison

After testing, provide a navigable walkthrough with concrete file paths and small
side-by-side code excerpts. Follow one message from API response to visible row,
detail, selection, action, and post-action refresh in each implementation.

Cover:

1. Entry points, setup, packaging and how to run each test suite.
2. What the frameworks supply: layout, measurement, ANSI, widgets, focus, themes,
   scrolling, Markdown and test helpers.
3. What Coleo still supplies: resource recipes, selection semantics, commands,
   transport/recovery policy and responsive composition.
4. How to add a column, a card fact, a filter, a command, a shortcut and a theme.
5. Where CLI/TUI presentation is actually shared, and where it is duplicated.
6. Python contract/conformance duplication versus TypeScript's shared modules.
7. Readability and size of handwritten UI glue, excluding generated files, locks,
   fixtures and tests from implementation-size comparisons.
8. Framework-specific workarounds, native dependency/build requirements, API churn,
   terminal cleanup behavior, and platform support actually tested.

Use a scorecard, with Tim's weighting, for user experience, opinionated component
coverage, developer API clarity, reusable CLI/TUI rendering, testing/debugging,
packaging, maintenance risk, and the cost of adding a language. Report measured
startup/resize observations with environment details; do not infer reliability
from release frequency, stars, or a single successful run.

**Final output (completed):** Tim's explicit selection is Python/Rich + Textual.
The remaining work is implementation and staged consolidation, not another
framework bake-off.

## Scope guardrails

- Preserve existing user changes and keep commits scoped when commits are requested.
- Do not rewrite the server, browser, or existing Arms TUI as part of the historical comparison. Their future relocation or client integration is separately staged.
- Backend fixes needed for shared correctness apply equally to both candidates.
- Keep appearance in a theme and use framework primitives; a timeline component
  may be custom, but it should not require inventing another text/layout engine.
- Keep snapshot commands useful without a TTY and without entering alternate screen.
- Do not confuse passing shared API tests with proving interactive TUI behavior.
- Library upgrades, dependency choices, and unsupported capabilities belong in the
  evidence record. Python/Textual is selected; parity gates still govern when the
  remaining Bun snapshot CLI can be deprecated. OpenTUI remains for the Arms dashboard.
