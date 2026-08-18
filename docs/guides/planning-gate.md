---
title: Planning Gate
description: See how Coleo turns project intent into a safe, ordered queue before agent work begins.
banner:
  src: /coleo-guide-planning-gate.png
  alt: A thoughtful octopus studies a luminous garden plan beside an open brass gate and a carefully ordered path of glowing stepping stones.
  eyebrow: Before Work Begins
  position: center 50%
---

# Planning Gate

The Brain uses the planning gate to turn project intent into a safe, dependency-ordered task queue before any arm receives instructions. The gate prevents a new project from starting with a technical requirement that depends on missing architecture, tooling, or setup decisions.

## What the Brain reviews

Before opening the gate, the Brain evaluates:

- The complete `.project/plan.md` document.
- Local Markdown plan documents linked from the primary plan.
- Porcelain Git status, collected with a strict size and entry limit.
- A bounded, shallow list of project filenames.

Coleo does not read source-file contents for the workspace inventory. Filenames and Git state are hints only; the planner must not claim that an implementation exists based on a filename.

The planner preserves requirements and commentary while adding implied prerequisite, architecture, setup, integration, validation, and delivery work. If an important choice cannot be inferred safely, it adds an early decision task instead of silently selecting a stack.

## Gate lifecycle

### Pending

Harness processes may be spawned before the first Brain poll, but the API does not send them an initialization prompt. Their generated identity prompt and any caller-provided startup instructions are stored for later delivery.

### Open

When evaluation, parsing, synchronization, and queue ranking all succeed, the Brain opens the gate. It returns planning-blocked arms to `idle`, then sends each new arm its deferred startup instructions and the standard initial-arm prompt.

### Blocked

If any planning stage fails, the Brain performs these actions in order:

1. Sends the user a planning-error mail message.
2. Interrupts arms that are already processing work.
3. Marks nonterminal arms as `planning_blocked` so the Web UI clearly shows why they are waiting.
4. Marks active tasks with the system-owned `planning` blocker.
5. Ends the poll before arm initialization, assignment, blocked-task review, or idle prompting.

An arm that cannot be interrupted is stopped to enforce the gate. Existing task blockers are preserved rather than replaced by the planning blocker.

## Recovery

The blocked plan set is identified by a hash of the primary and linked plan documents. Repeated polls do not reopen the gate or repeatedly initialize arms. Edit the primary plan or one of its linked plan documents to trigger a new evaluation.

After successful reevaluation, Coleo resumes only tasks with a valid planning-state marker and only arms with the `planning_blocked` status. Ordinary dependency, bug, environment, human, and runtime blockers remain unchanged.

## Customizing the planner

The model messages are user-editable Jinja templates:

- `.coleo/src/brain/templates/plan-evaluation-system-prompt.jinja`
- `.coleo/src/brain/templates/plan-evaluation-user-prompt.jinja`

The template manager copies packaged defaults into the project without overwriting local edits. The system template controls planning policy. The user template controls how the plan, linked documents, Git status, and filename inventory are presented.

## Requirements

When `task_auto_discover` is enabled, planning requires:

- A readable `.project/plan.md`.
- A configured Brain model and API key.
- A reachable Coleo API and task database.

Planning intentionally fails closed when these requirements are unavailable.

## Troubleshooting

### Arms show “Waiting on planning”

Open the Brain’s planning-error message and correct the reported problem in the primary or linked plan. Arms will not accept direct prompts while the gate is blocked.

### Git status is very large

Coleo streams and truncates Git output before adding it to the model prompt. A truncation marker is included so the planner knows the inventory is incomplete. Generated and dependency directories should still be ignored in the repository where practical.

### Tasks stay blocked after fixing the plan

Confirm that the edited file belongs to the primary plan set and that the Brain model is configured. Non-planning blockers are not automatically removed by a successful planning pass.
