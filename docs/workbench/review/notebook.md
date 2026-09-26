# The notebook: remember whose edit is being saved

**P1 — profile ownership and lost-edit risks. Runtime changes deferred.**

Database-backed configuration is the right foundation. However, “persisted”
does not specify what happens when two panels edit the same view, a save fails,
or the user changes profiles. Those cases are part of the feature, not storage
implementation details.

## N1: Inbox attention is still effectively local-profile state

The API stores attention by `(profile_id, item_key)`, but the frontend's
[Inbox load and read actions](../../../src/web/src/pages/MessagingPage.tsx)
omit the active profile. [API client defaults](../../../src/web/src/lib/api.ts)
select `local` for list/bulk operations; `getWorkbenchItemAttention` has no
profile parameter. [The detail loader](../../../src/web/src/pages/load-inbox-item.ts)
uses an item-only query key while merging in that attention state.

Further, [card action handlers](../../../src/api/routes/workbench-cards.ts)
hardcode `profileId: "local"` for resolve/snooze/assign, and card-instance
creation in the client explicitly sends `local`. This is an end-to-end
ownership gap; adding a profile to one hook would leave the other paths wrong.

**Observed:** the selected profile is not passed through these paths.
**Consequence:** selecting another profile changes layouts/preferences but
Inbox attention operations still affect `local`. The docs' portable identity
story does not describe this limitation. This is not an authentication claim:
profiles are explicitly UI identities, not security principals.

**Recommended choice:** make attention personal to the active workbench
profile, passing identity through queries, cache seeding, commands, and server
validation. If attention is intentionally project-global, document that and
stop implying that switching profiles changes it. Do not silently choose one.

## N2: a boolean cannot identify an asynchronous save

[useViewPreferences](../../../src/web/src/workbench/use-view-preferences.ts)
stores one `dirtyRef`, debounces a complete preferences object for 500 ms, then
clears dirty in `finally`. The source establishes these gaps:

- A failed save clears dirty and has no returned save-error state. A later
  server refresh may replace the unsaved draft. `finally` is also not rejection
  handling; the discarded promise can reject without a UI path.
- Save A can be in flight when the user makes edit B. A's completion clears
  the same flag used by B. Subsequent provider/cache renders can cancel B's
  timer or accept A's older preferences. There is no revision comparison.
- Unmount cancels the pending timer without flushing or otherwise retaining
  the draft. Changing mode/closing a panel before 500 ms can lose the change.
- The hook has no explicit profile/view identity reset. If it remains mounted
  through a profile switch while dirty, it can retain A's draft while adopting
  B's save callback. Golden Layout may remount panels on profile changes, so
  this scenario particularly needs verification in the classic shell; it is
  not claimed as a reproduced cross-profile write in every shell.

Provider-wide callback identity changes also restart debounce effects. The
[profile context](../../../src/web/src/workbench/profile-context.tsx) exposes
views, layouts, profile data, and mutation functions in one changing value;
`useSavedView` depends on that whole context. This makes unrelated refreshes
part of a save's timing. Splitting contexts is a possible later optimization,
not a substitute for fixing save identity.

**Recommended choice:** represent a draft with `(profileId, viewKey, revision)`
and track the revision being saved. A completion acknowledges only its own
revision. Serialize writes for the same view, retain newer drafts and errors,
and define close/switch behavior explicitly. A small reducer can model
`edited`, `saveStarted`, `saveSucceeded`, `saveFailed`, and `identityChanged`;
an effect owns the timer/network. No state-machine library is needed.

The default product policy I would propose: keep edits across mode switches,
flush on an intentional panel close, and show failed saves with retry. Browser
termination is a separate durability problem; an unawaited cleanup request
must not be described as a guaranteed flush.

## N3: versions count changes but do not prevent conflicts

[The view update route](../../../src/api/routes/workbench.ts) increments
`version = version + 1` with `WHERE id = ?`. It does not compare the caller's
version. Two panels/devices can read version 1, edit different fields, and both
successfully replace the whole preferences object. The second accepted write
can erase the first. Profile preferences have the same whole-object replacement
shape, without a revision field.

**Reproduced against the actual routes and a temporary database:** create a
sheet view with compact density; retain its version-1 snapshot; PUT that
snapshot with a hidden Subject column; then PUT the same version-1 snapshot
with comfortable density. Both responses are 200, the final version is 3, and
the column edit is absent. A separate copy-mode import with `schemaVersion: 999`
returned 201. These observations do not depend on a simulated React race.

`updateProfilePreferences(updater)` looks like a React functional update, but
it evaluates against a captured profile snapshot before the request. It is
not an atomic server update. Two toolbar edits can therefore overwrite one
another despite both using an updater function. Function syntax does not supply
distributed concurrency control.

There is a related documentation gap: the guide calls layouts schema-versioned.
The layout record's `version` is a write revision; profile export emits
`schemaVersion: 1`, but import does not validate that schema version before
replacing configuration. A write counter and a schema version solve different
problems. Future imports need an explicit accepted-version/migration policy.

**Recommended choice:** for shared view writes, require an expected revision
and return a conflict when it no longer matches. Keep the draft and offer reload
or deliberate retry. Add serialization in the browser for its own edits; that
alone cannot protect another device. Avoid a CRDT for view preferences.

**Alternative:** explicitly accept last-write-wins, documenting that simultaneous
edits can overwrite each other. That may be sufficient for single-user layouts,
but it is a weaker promise than collaborative saved views. Copy-on-edit of
another profile's shared view already exists in `useSavedView` and should stay.

## Proposed follow-up commits, only after selection

| Commit | Bounded change | Acceptance |
| --- | --- | --- |
| `fix(workbench): scope attention to the active profile` | Carry profile identity through list/detail/cache/action paths | Two profiles see independent read/resolved state; switching with details open cannot reuse the wrong attention cache |
| `fix(web): preserve preference drafts across asynchronous saves` | Revision-aware draft lifecycle and visible save errors | Delay A, edit B, finish A; B survives. Reject a save; draft survives. Close/switch/mode behavior matches the chosen policy |
| `fix(api): reject stale saved-view revisions` | Compare expected version transactionally; expose conflict to the editor | Two writes from one version cannot silently erase each other; copy-on-edit still works |
| `fix(workbench): validate imported configuration versions` | Validate bundle schema before destructive replacement | Unsupported version leaves existing configuration untouched; supported export/import round-trip remains valid |

Do N1 and N2 before extracting a reusable persistence package. The reusable
asset is a precise draft/save protocol; a generic wrapper around the current
races would only distribute the bug to the next application.
