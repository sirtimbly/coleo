# Task Backlog

Tasks are not stored here. The backlog is the **project plan** (`.project/plan.md`) and any **phase plans** (`.project/plans/`).

## How Work Is Determined

The brain reads the plan documents and creates tasks one at a time:

1. **Read `.project/plan.md`** → find current incomplete phase
2. **Read phase deliverables** → items marked `[ ]` are pending work
3. **Create ONE task** in the database
4. **Wait for completion + verification** before creating the next

## Plan Locations

| File | Purpose |
|------|---------|
| `.project/plan.md` | Master project plan with all phases |
| `.project/plans/*.md` | Detailed phase plans |
| `.project/acceptance/*.md` | Phase acceptance criteria |

## What This Directory Was

Previously contained task lists. Now kept for reference:
- `completed.md` → historical task record (see database)
- `backlog.md` → this file (redirects to plan)
- `current.md` → current brain/task status (see database)

## Future Work

Ideas and features not yet in the plan are tracked as:
- GitHub issues
- Email threads to the brain
- Notes in `.project/feedback/pending.md`
