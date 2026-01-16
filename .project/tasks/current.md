# Current Tasks

The brain creates tasks one at a time from the project plan. Current task status is tracked in the database.

## Current Status

**Phase 2.1: Progressive Planning** (In Progress)

The brain is actively determining and assigning tasks based on the project plan.

## Active Task

See `octopai brain prompt:task` or the database for the current task being worked on.

---

## How Tasks Flow

1. **Brain reads plan.md** → finds current incomplete phase
2. **Brain creates ONE task** in the database for the next item
3. **Arm requests work** → Brain returns the pending task
4. **Arm claims task** → status changes to `in_progress`
5. **Arm completes work** → status changes to `verification_pending`
6. **Another arm verifies** → status changes to `completed`
7. **Brain creates next task** → repeat

---

## Recent Activity

See `octopai activity` or the API for recent arm activity.

## Notes

Tasks are ordered by plan dependencies and priority. The brain automatically determines what to work on next based on:
- What's in the current phase of plan.md
- What's already completed
- What discoveries have been made
- What the human has requested
