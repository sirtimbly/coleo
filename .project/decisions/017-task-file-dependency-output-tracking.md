# ADR-017: Task-File Dependency and Output Tracking

## Status

Accepted

## Date

2026-09-22

## Context

Phase 0 requires that task dependencies on files and verification of task
outputs be defined before implementation work is assigned. The plan states
that existing filenames, modified files, generated artifacts, checkbox
states, and test names are not evidence of completion until behavior has
been inspected and validated.

Verified 2026-09-22: no task-file reference convention exists. Searches for
`task_file`, `taskFile`, `output_file`, and `outputFile` in `src/db/` and
`src/api/` return no matches. The existing per-task record types are
`task_summaries`, `task_diffs` (with `task_diff_views`), `task_checklist_items`
(migrations 056/057), and `task_comments`. Phase 6 plan items
"Add task-file references" and "Verify task outputs before completion" will
implement durable storage; this record defines the convention they must
follow. ADR-014 already anchors every pass to the original task and branch.

## Decision

### 1. Reference categories

Every task declares typed references to the files and criteria it depends on
and produces. Exactly six categories exist:

| Category | Meaning | Example |
|---|---|---|
| `acceptance_criteria` | The acceptance record or checklist the work must satisfy | `.project/acceptance/phase-1.md`, plan deliverable line |
| `decision` | An ADR or decision constraining the work | `.project/decisions/012-*.md` |
| `plan` | The plan document or sub-plan authorizing the work | `.project/plan.md`, Phase 11 section |
| `source_file` | Repository code the task will read or modify | `src/api/routes/tasks.ts` |
| `context_file` | Supporting material needed to do the work (docs, fixtures, prior reports) | `.project/reports/runtime-stack-validation-2026-09-22.md` |
| `output_file` | A file the task is expected to create or modify | `.project/decisions/017-*.md`, `src/api/routes/example.ts` |

Each reference records: the original task ID, the category, the repository-
relative path, and the relationship semantics (`requires` for inputs that
must be read, `constrains` for criteria/decisions/plans that bound the work,
`produces` for expected outputs). References to generated artifacts, caches,
evaluation fixtures, and bakeoff reports are `context_file` evidence only;
per ADR-016 they never satisfy `acceptance_criteria` or `output_file` roles.

### 2. Verification of outputs before completion

Every `output_file` reference declares a verification method and must have a
recorded result before the task (or its merge pass) completes:

- `typecheck` / `lint` / `test` / `build` — the named authoritative command
  was run and passed for the output (see the Phase 0 validation-commands
  task for the canonical command set).
- `inspection` — a human or reviewer inspected the output; the reviewer and
  timestamp are recorded. Used for Markdown plans, decisions, and reports
  where automated checks cannot prove intent.
- `exists` — the file exists at the declared path. This is the minimum and
  is never sufficient alone for code outputs.

Completion requires, per output: the file exists, it is attributable to the
task (created or modified on the task's branch after the recorded baseline,
or explicitly adopted with justification), and its verification result is
recorded and passing. A completion report that claims outputs without these
records is incomplete; review/polish passes must request them rather than
assuming them.

### 3. Anchoring to the original task and branch

All file references and output/verification records attach to the original
task ID and its canonical branch, consistent with ADR-014. Implementation,
review, polish, human review, and merge are passes on that task; their file
observations accumulate on the original task rather than on child tasks.
A linked task (permitted only for genuinely independent follow-up work with
distinct acceptance criteria) carries its own references and records its
relationship to the source task.

### 4. Baseline comparison for output attribution

Because the workspace may be dirty, outputs must be compared against a
recorded pre-work baseline (`git status --porcelain` and base commit taken
at task start). The canonical baseline lives in `.project/status.md` once
the status-record task (phase0pl-c84714) creates it; until then each task
records its own baseline in its first status report or summary. Files
modified before the baseline that the task did not touch cannot be claimed
as task outputs.

## Consequences

- Phase 6 storage work ("Add task-file references", "Verify task outputs
  before completion") must implement these six categories, the
  requires/constrains/produces semantics, per-output verification methods
  and results, original-task anchoring, and baseline comparison — not a
  competing local contract.
- Completion, reviewer, and merge logic must reject completion when a
  declared output lacks a passing verification record.
- `update_task_summary` and `record_task_diff` remain the interim,
  API-mediated mechanisms for progress and diff evidence until durable
  task-file storage lands; they do not replace verification records.

## Related Records

- ADR-014 (branch-centered lifecycle), ADR-016 (source-of-truth boundaries)
- `.project/plan.md` Phase 0, Phase 3, Phase 6, Phase 18
- Migrations 056/057 (`task_summaries`, `task_diffs`, `task_checklist_items`)
