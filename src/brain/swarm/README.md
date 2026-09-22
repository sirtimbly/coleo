# Swarm activity-window evaluation

An optional poll stage evaluates one shared snapshot through JEV, then dispatches
supported proposals through existing Coleo APIs. It runs after the current poll's
handlers and idle prompting, so their recent actions can inform the decision.

```sh
# Run against the upgraded API with execution enabled.
bun run brain --swarm-evaluation execute --swarm-window-polls 10

# Collect/evaluate proposals without executing this stage's actions.
bun run brain --swarm-evaluation shadow

# Replay a saved API snapshot without running Brain or any actions.
bun run src/scripts/eval-swarm-window.ts --snapshot snapshot.json
```

Requires `JEV_API_KEY` and API database migrations through `071_swarm_recommendations`.
The normal API initialization migration path applies it. Upgrade/restart the API
before enabling the stage. The feature defaults to off. The Brain screen provides **Evaluate swarm activity**
and **Execute swarm actions** switches, plus the activity window in polls. Turning
on evaluation starts in proposals-only mode; execution must be enabled separately.
Settings are saved in project configuration and reloaded on each evaluation.
Changes are checked again before dispatch, so disabling execution also cancels
pending actions from an in-flight evaluation (actions already started can finish).

Explicit CLI flags or `BrainOptions` set and persist startup values; subsequent web
changes override them without restarting Brain. `COLEO_SWARM_EVALUATION=execute|shadow`
seeds the mode at startup only when no saved mode exists. Saved choices survive a
restart unless an explicit startup flag overrides them.
Shadow mode affects only this new stage; the rest of a running Brain still acts.

## Window and state

The default lookback is **poll interval × 10**: a 30-second interval produces a
five-minute window. Every poll advances the window with overlap. A positive poll
interval is required. The multiplier is configurable from 1 to 100.

The API collects project-scoped JetStream events from all arms in time order,
including message/tool output carried by those events. It includes current arm
state, recently changed or assigned tasks, referenced tasks, open/recent bugs and
discoveries, legacy Brain activity in the window, and durable evaluation action
receipts. Older executing/uncertain receipts remain visible beyond the window.
This does not fetch full harness transcripts outside JetStream or every old task.

Missing JetStream, truncated events, and record limits are explicit coverage
failures: classification can still produce proposals, but execution is blocked.
There are bounds of 1,000 raw events, 100 relevant tasks, 100 bugs and 100
discoveries. Event bodies are capped at 2,500 characters with a coverage flag.
Queries over a conservative 100,000-character combined state/question budget fail
without dispatch; this is a character guard, not an exact tokenizer. No history
is silently dropped to fit a model call. Adaptive batching is future work.

## Questions and execution

Independent choices assess each candidate action on a supplied entity:
`act`, `wait`, `handled`, `not_needed`, or `insufficient_evidence`. A second request
selects source evidence, a reason and constrained parameters for up to eight
candidates. Decisions, input snapshots and proposals are persisted before effects.

Supported execution adapters:

| Action | Execution |
|---|---|
| Stop arm | Existing arm kill endpoint, with version precondition |
| Prompt arm | Existing non-interrupting prompt endpoint |
| Change task | Priority and guarded pending/blocked corrections only |
| Comment on task | Existing discussion endpoint with Brain authorship |
| Log discovery | Existing discovery endpoint with source evidence |
| Create bug | Existing bug endpoint, including its duplicate check |
| Change bug | Append evidence to description and optionally adjust priority |
| Message human | Existing Brain mail path |
| Restart dev server | Proposal only; managed process identity/adapter needed |
| Preserve Git work | Proposal only; verified worktree/ownership/strategy needed |

Text is assembled from source evidence and fixed templates. JEV does not invent
shell commands, generate prose, or select arbitrary paths. General task edits,
completion, cancellation, bug resolution and lifecycle approvals are not automated
by this first adapter set. Existing lifecycle workflows remain responsible for them.

Execution requires complete coverage and probability ≥0.90 (≥0.98 for stopping
an arm). The probability is the minimum of the selected route and detail-choice
probabilities, not a calibrated joint probability. These are provisional policy
thresholds. Lower confidence and unsupported actions remain recorded proposals;
they do not automatically become questions to the human.

Only one effect per target is dispatched in a poll. Task status corrections cannot
override assignments, dependency blocks, planning blocks or human-review blocks.
Task/bug updates use an atomic version precondition; arm stop/prompt handlers check
the version again before operating. External arm operations are not atomic with
database changes, so uncertain outcomes must be reconciled.

## Preventing repeated actions

The persistent action ledger is separate from model judgment:

1. An atomic SQLite reservation happens before dispatch. Concurrent polls and
   processes cannot reserve the same evidence/action twice.
2. Prompts and stops share an arm intervention scope. Successful actions impose
   a cooldown equal to the window length even when new messages paraphrase an issue.
3. After cooldown, evidence must be newer than the last successful result. Moving
   the window or rerunning the classifier does not make old evidence actionable.
4. Executing and uncertain actions block that scope until reconciled. A crash
   after reservation is not automatically retried, including after Brain restarts.
5. The same evidence cannot create duplicate bugs/discoveries/notifications under
   different arm targets. Recent recognized legacy actions also suppress execution.
6. The Brain's prior receipts and activity are supplied to the model to recognize
   semantic repetition, including follow-ups already in progress.

This is conservative at-most-once dispatch for a reserved operation, not a claim
of exactly-once effects across remote services. A crash between reservation and
dispatch can leave work unperformed; avoiding an unsafe repeat takes precedence.
Legacy handlers keep their own deduplication rules. This ledger does not retrofit
every existing handler with the new guarantees.

Shadow proposals can be promoted by a later execute-mode evaluation after fresh
state checks. Permanent same-evidence receipts and unresolved outcomes survive
restarts. Different genuinely new incidents remain possible after cooldown.

## Inbox history

Each unique recommendation appears in **Inbox → Brain → Decisions**, including
proposals below the confidence threshold, unsupported capabilities, and actions
suppressed by repeat/state checks. The entry includes the action, target, original
model score and parameters, source evidence, evaluation window, and execution
outcome or the reason it stayed a proposal. The same action/evidence pair gets one
stable Inbox entry across overlapping polls; its outcome updates in place without
resetting read/archive state. Uncertain outcomes are marked as requiring attention.

Recommendation entries are stored atomically with the evaluation audit before
any external effects. They remain available by their direct Inbox link after the
activity window has passed. These are local Inbox history records; the separate
`notify_human` capability still controls sending actionable human notifications.

## Inspection and reconciliation

Authenticated API endpoints under `/api/brain/internal/swarm`:

- `GET /snapshot?pollIntervalMs=30000&windowPolls=10`
- `GET /actions?since=<ISO timestamp>` (also returns older unresolved executions)
- `GET /evaluations` (latest 100 result records)
- `POST /actions/:id/reconcile` with `{status: "succeeded" | "rejected", detail}`
  after an operator verifies whether the external action happened. The explanation
  must be at least ten characters. The evaluator never calls reconciliation.

The API database retains full snapshots/results in `brain_swarm_evaluations` and
operation receipts in `brain_swarm_actions`. They contain private source text and
currently have no automatic retention policy. Common credential fields in events
are redacted. Evaluation failures produce audit records and do not dispatch actions.

Test coverage includes overlapping polls, new evidence during cooldown, stale
versions, actual API adapter payloads, missing history, shadow promotion, restart
recovery, and ambiguous post-dispatch failures.

## Brain settings and prompt editing

The Brain web page contains the report's twelve responsibilities, with scoped
built-in switches and per-action JEV choices. Configuration persists under
`brain.responsibility_enabled` and `brain.swarm_action_modes` in Coleo's TOML.
Omitted settings preserve existing behavior. Individual JEV actions may inherit
the global evaluator mode, remain proposal-only, or be disabled entirely.
The runner rechecks settings before dispatch; changing the action map cancels
remaining actions from an older evaluation. Global execution never bypasses an
individual action restriction or the existing execution guards.

Built-in switches control assistant-output follow-ups, inferred bug creation,
inferred task updates, idle work nudges, poll-loop stuck analysis, blocked-task
reviews/escalation, and incoming human mail processing. They do not globally
transfer responsibility to JEV. In particular, initial assignment, explicit
reports, completion, planning, permissions and the independent health monitor
remain active. The UI describes each boundary. Disabling mail processing leaves
incoming messages waiting; re-enabling resumes processing. Assistant-output
messages classified while an effect is disabled are still marked processed.

Hover/click template chips to read effective local text and open the exact file
in Plan & Documents. Local overrides are in `src/brain/templates/` inside the
configured Coleo directory, represented in the editor as `.coleo/...` even with
a custom `COLEO_DIR`. Writes retain optimistic content-hash checks.

`jev-swarm-policy.jinja` contains shared instructions.
`jev-swarm-questions.jinja` is JSON containing all question language and choice
criteria. Preserve object keys and placeholders; saves reject malformed JSON,
missing/extra keys and empty text. Runtime loads both once per evaluation, so an
in-progress query keeps its original text. Dynamic evidence options, typed
values, thresholds and execution adapters remain code-owned. Packaged defaults
also serve replay callers without a template manager.

Proposal-only mode remains observation after built-in handlers, not a fair
same-snapshot comparison. No replacement speedup is implied by these controls.

## Runner contract

Reference for `runner.ts`, `evaluator.ts`, `types.ts`, `budget.ts`,
`prompts.ts`, `context.ts`. Verified against source 2026-09-22; swarm
unit suites (`swarm-evaluation`, `swarm-budget`, `swarm-context`) pass.

### Inputs (`SwarmRunnerOptions`)

- `mode`: `"shadow"` (proposals only) or `"execute"`. Never `"off"`
  (the stage is not constructed when off).
- `windowPolls` (default 10, allowed 1–100) with the poll interval from
  each `poll()` call defines the snapshot window
  (`windowBounds`: `since = now - pollIntervalMs * windowPolls`).
- `api`: authenticated `SwarmRequest` (`X-API-Key`, 15 s timeout,
  `X-Coleo-Expected-Version` on mutating dispatches).
- `evaluate`: snapshot → `SwarmEvaluation` (production: `SwarmEvaluator`
  with `JEV_API_KEY`, model `jev-latest`).
- `notifyHuman`, `log`, optional `shouldStop`, per-action `actionModes`
  (`inherit` | `shadow` | `off` from `brain.swarm_action_modes`).

### Candidate arms and models

`candidatesFor(snapshot)` derives candidates per entity: arms get
`log_discovery`, `create_bug`, `notify_human`, `restart_dev_server`,
`preserve_git_work`, plus `prompt_arm`/`stop_arm` unless stopped, error,
or paused; tasks get `update_task`/`comment_task`; bugs get
`update_bug`. There is no model roster to configure — the single
evaluator model (`jev-latest` via `JEV_API_KEY`) judges all candidates,
and per-action modes gate (not route) behavior. Arms stay
general-purpose: candidacy is eligibility, not specialization.

### Prompt construction

Two JEV choice-question rounds over a fitted snapshot: routing
(`act`/`wait`/`handled`/`not_needed`/`insufficient_evidence` per
candidate, top 8 by `act` probability) then detail (evidence, reason,
priority, status, prompt). Text comes from `jev-swarm-policy.jinja`
plus `jev-swarm-questions.jinja` (key-stable; saves reject shape
changes); thresholds, adapters, and evidence options stay code-owned.
Answers are Zod-validated (known choices, full probability maps,
sums ≈ 1).

### Result schema

`SwarmEvaluation { proposals: SwarmProposal[], decisions[], model,
elapsedMs, contextReductions? }`. Each proposal carries action,
target, expected version, reason, evidence reference/text (≤ 8000
chars), probability (min of route and detail confidences), and bounded
parameters. Receipts persist in `brain_swarm_actions` with status
`proposed → executing → succeeded | uncertain | rejected`; evaluations
and snapshots persist in `brain_swarm_evaluations`; recommendations
mirror to Inbox → Brain → Decisions. Nothing here mutates tasks, arms,
or plans except through the existing API adapters below.

### Cancellation

`shouldStop` is checked before each proposal and before dispatch; a
stop rejects the reserved receipt with cause and halts the poll.
Disabling execution (or changing the action map) cancels remaining
actions from an in-flight evaluation; started effects may finish and
must be reconciled. Overlapping `poll()` calls are skipped
(`running` guard).

### Failure behavior

Evaluator throw → audit record + `Swarm evaluation failed` with no
dispatch. Failed/ambiguous dispatch → `uncertain` receipt requiring
operator `reconcile` (`POST /actions/:id/reconcile`, ≥ 10-char
explanation); the durable `executing` receipt blocks silent retry.
Unpersisted finish → hard error (`outcome was not persisted`).
Incomplete coverage or sub-threshold probability (≥ 0.90, ≥ 0.98 for
arm stop) → recorded proposal, never dispatched. Atomic reservation +
per-target single effect + cooldowns + version preconditions give
at-most-once dispatch, not exactly-once remote effects.

### Resource limits

- Context: 100 000 chars total / 90 000 state+questions, 4 fitting
  attempts at 0.7× scale, ≤ 255 criteria options; reductions recorded.
- Model: 12 s timeout, zero retries (except context-size 400/413/422
  refits); 15 s API timeout.
- Snapshot: 1 000 raw events, 100 tasks/bugs/discoveries, 2 500-char
  event bodies; coverage gaps fail closed for execution.
- Evaluator requires `JEV_API_KEY` at construction (fail-closed);
  evaluations need ≥ 1 event and ≥ 1 eligible candidate or return empty.

### Future work

Adaptive batching of oversized snapshots; retention policy for
`brain_swarm_*` tables (currently unbounded, contain private source
text); long-running swarm evaluations remain outside the plan-evaluation
lock, which guards only plan prepare/regenerate/sync.
