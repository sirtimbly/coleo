# Task Workflow

Tasks are the brain's durable work queue. A status controls whether work can be assigned; it is not only a display label.

## Statuses

| Status | Meaning | Normal next states |
| --- | --- | --- |
| `pending` | Runnable, unassigned work in queue order. | `claimed`, `blocked`, `cancelled` |
| `claimed` | An arm owns the task but has not acknowledged active work yet. | `in_progress`, `pending`, `blocked` |
| `in_progress` | The assigned arm is actively working. | `completing`, `blocked`, `failed`, `pending` |
| `completing` | Work was reported complete and is waiting for validation or human approval. | `completed`, `in_progress`, `blocked` |
| `blocked` | Work cannot continue for a recorded reason. It is removed from the runnable queue and added to the blocked review queue. | `pending`, `cancelled`, `blocked` with an updated review |
| `completed` | Work was accepted as complete. | `pending` to reopen |
| `failed` | Work ended unsuccessfully. | `pending` to retry, or `cancelled` |
| `cancelled` | Work is intentionally closed without completion, including obsolete work. | `pending` to reopen |

The brain manages `claimed`, `in_progress`, `completing`, and `completed`. Human controls can return work to `pending`, record a blocker, mark a failure, or cancel obsolete work. These transitions release stale task assignments.

## Blocking Rules

A task cannot enter `blocked` without a non-empty, concrete reason. A block also records:

- A category: dependency, bug, file claim, environment, human, arm/runtime, or unknown.
- When the block started.
- When it should next be reviewed.
- How many reviews have occurred.
- Whether a human response is needed.
- Which arm, if any, currently holds the review lease.

Examples of useful reasons:

- `Waiting for task-42 to complete because it creates the migration used here.`
- `Bug bug-17 still breaks the upload endpoint.`
- `Production credentials must be provided by a human.`

`Blocked`, `waiting`, or `cannot continue` without the actual dependency or decision is not a sufficient reason.

An arm submitting a blocked status report must list at least one concrete blocker. Other brain paths, such as an arm restart, unresolved bug, or file claim conflict, generate their own reason and category.

## Blocked Review Queue

Blocked work is reviewed separately from runnable work:

1. The brain selects due blocked tasks by `next review`, then by the oldest block time and task ID.
2. Each available arm receives at most one review assignment with the task, current blocker, and recent discussion.
3. The arm researches the current repository and runtime state. It must not assume that an old blocker is still valid.
4. The arm reports exactly one outcome:

| Review outcome | Result |
| --- | --- |
| `unblocked` | Return the task to `pending` so normal work can claim it. |
| `still_blocked` | Save an updated reason/category, optionally request a human response, and schedule another review. |
| `irrelevant` | Cancel obsolete, duplicated, or already-satisfied work. |

This relevance check is important for old housekeeping tasks such as "verify and polish", "validate completion", or "commit changes". The reviewing arm must inspect current state and cancel the task when its requested outcome is already satisfied or no longer applies.

Repeated machine-actionable blockers back off from 15 minutes to 1 hour, 4 hours, and then 12 hours. Tasks waiting for a human are checked daily. A review assignment has a lease so an abandoned review becomes eligible again.

## Human Replies

Task discussion comments are both history and input to the workflow.

- A human comment on a blocked task moves its next review time to now and clears the `waiting for human` flag.
- A human email carrying the task thread ID is added to the same task discussion and has the same effect.
- The next brain poll can assign an arm to reassess the task with that reply included in its prompt.
- If a review determines that a human decision is still required, the brain emails the human with the current reason. Reply in Discussions or on the task email to requeue it immediately.

Comments from arms and the brain remain in the discussion as a chronological explanation of status reports and review outcomes. The task's blocked fields are the canonical current blocker.

## Web Controls

Open a task and use the `...` action menu to:

- Edit all task fields.
- Unblock or reopen the task by moving it to `pending`.
- Mark it failed or cancelled; cancellation requires confirmation.
- Mark it blocked through the edit form, where a reason is required.

The blocked notice in task details shows the current reason, category, next review time, review count, and whether human input is needed.
