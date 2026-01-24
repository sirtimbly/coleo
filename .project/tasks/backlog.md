# Task Backlog

Tasks are not stored here. The backlog is the **project plan** (`.project/plan.md`) and any **phase plans** (`.project/plans/`).

## How Work Is Determined

The brain reads the plan documents and inbox during each poll cycle:

1. **Read `.project/plan.md`** → extract tasks from `- [ ]` items under `### Deliverables`
2. **Read `.project/inbox.md`** → convert inbox items to tasks, clear inbox
3. **Deduplicate** → skip items that match existing tasks
4. **Create tasks** in the database
5. **Assign to idle arms** → one task at a time

## File Locations

| File | Purpose |
|------|---------|
| `.project/plan.md` | Master project plan with phases and deliverables |
| `.project/inbox.md` | Quick task input - items converted to tasks and removed |
| `.project/plans/*.md` | Detailed phase plans |
| `.project/acceptance/*.md` | Phase acceptance criteria |

## Adding Ad-Hoc Tasks

To add a task outside of the plan structure, add it to `.project/inbox.md`:

```markdown
## Task Title
Optional description with more details.

Or simple format:
- [ ] Single line task
```

The brain will:
1. Parse the inbox on next poll
2. Create tasks in the database
3. Clear the inbox

## What This Directory Was

Previously contained task lists. Now kept for reference:
- `completed.md` → historical task record (see database)
- `backlog.md` → this file (redirects to plan)
- `current.md` → current brain/task status (see database)
