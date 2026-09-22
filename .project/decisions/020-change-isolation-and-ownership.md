# ADR-020: Change Isolation and Ownership Rules

## Status

Accepted

## Date

2026-09-22

## Context

Multiple arms work concurrently on one repository. Without isolation
rules, concurrent edits corrupt each other's outputs, dirty-tree
attribution becomes impossible (134+ dirty paths observed 2026-09-22),
and migrations or generated files collide. Verified 2026-09-22: git
worktrees are the live isolation mechanism (main checkout plus arm PR
worktrees, e.g. under `/private/tmp/coleo-*`); `.gitignore` excludes
`node_modules`, `dist`, coverage, `.env*`, caches, and `gitea-data`;
the `claims` table with MCP file-claim tools governs file contention;
ADR-014/017/018 define lifecycle anchoring, baselines, and assignment
gates. This record binds those pieces into ownership rules.

## Decision

### 1. Branch and worktree ownership

- Each task pass works on the original task's canonical branch
  (ADR-014), checked out in an arm-owned worktree. Arms never commit in
  another arm's worktree and never push to another task's branch.
- Before starting, the arm records a baseline: base commit plus
  `git status --porcelain` of its worktree (ADR-017). Pre-existing dirt
  is context, never claimed output.
- Checkpoint commits are small, conventional (`docs(...)`, `feat(...)`,
  `fix(...)`), and limited to the task's own files. Unrelated changes
  found in the worktree are left untouched and reported.

### 2. Claim and lease exclusivity

- A pass holds an exclusive or write claim on every `source_file` and
  `output_file` it will modify, and a single-use lease for the pass
  (ADR-014/018). Overlapping write/exclusive claims by two arms are
  refused; the second assignment waits with a recorded reason.
- Read claims never block. Lease expiry or explicit release is required
  before reassignment; stale-lease rejection changes no state.
- Destructive or uncertain actions (resets, large rewrites, cleanup of
  others' edits) require stashing first so nothing is unrecoverable.

### 3. Generated files

- Generated output (`dist/`, coverage, caches, `bun.lock` entries from
  installs, evaluation artifacts) belongs to the generating command, not
  to any task. Arms regenerate via authoritative scripts (ADR-019) and
  never hand-edit generated output unless explicitly approved.
- Generated files are never `output_file` evidence for completion
  (ADR-016/017); only their source inputs and the command result count.

### 4. Migration ownership

- Migration authorship is serialized: one task owns the migration
  catalog at a time (exclusive claim on `src/db/migration-catalog.ts`
  and the touched migration file). New migrations carry unique,
  ordered identifiers and are validated against the catalog
  (`migrateDatabase`/`assertDatabaseCompatible`) before merge.
- Database migrations never ship alongside unrelated feature edits in
  the same pass; rollback expectations follow the rollback-safety task.

### 5. Evaluation fixtures and locks

- Evaluation fixtures, datasets, and bakeoff reports are protected,
  separately owned artifacts (plan Execution Rules). Tasks consume them
  read-only; evaluation runs hold the evaluation lock and must release
  it, and their outputs never mutate tasks, plans, leases, or approvals
  without an explicit API-mediated action.

### 6. Concurrent-edit conflicts

- Disjoint files: proceed in parallel under separate claims.
- Same file, disjoint regions: second writer takes an exclusive claim
  and rebases onto the first writer's merged result; no silent
  overwrites.
- Same file, overlapping regions: serialize — the second task waits
  (ADR-018 waiting state) or is rescoped by the Brain. Merge conflicts
  are resolved in an explicit conflict-resolution pass on the owning
  task, preserving both sides' intent and re-running verification.

## Consequences

- The Brain must not assign two passes with overlapping write/exclusive
  claims or shared migration ownership.
- Violation handling (claim fights, rapid reclaims) escalates to the
  Brain for throttling/reassignment; arms do not retaliate or
  force-claim.
- Phase 6 durable storage must persist claims, leases, branches, and
  diff references so these rules survive restarts.

## Related Records

- ADR-014 (lifecycle), ADR-016 (sources of truth), ADR-017 (task-file
  tracking), ADR-018 (gates), ADR-019 (commands)
- `claims` table, MCP file-claim tools, `.gitignore`, worktree practice
