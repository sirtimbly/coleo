# Dependency Order Verification (2026-09-22)

Task: `phase2-bf2f12`.

Requirement: no classification routing, Brain task assignment, arm
selection, budget enforcement, or governance decision may depend on
unverified swarm or bake-off output.

## Verdict: VERIFIED (one documented interim exception)

Static import/query audit of the five decision paths (runtime code,
tests excluded), verified against the accepted boundary records
(ADR-016 §1, ADR-023 §1/§11, ADR-025 §5).

### 1. Classification routing — clean

`src/brain/prompt-generator.ts` derives classification from task
metadata only: `task.classification` / `task.domain` (:291, :372, :496,
:872) and hard-coded context values for generated tasks (`bug_fix` :135,
`architect` :450). Template selection reads no `brain_swarm_*` table and
no bake-off artifact. Production message classification
(`arm-output-processor.ts`, `mail-processor.ts`) is an input to the
system, not a consumer of evaluation output; the bake-off only measured
it.

### 2. Brain task assignment — clean

`assignTasks()` (`src/brain/brain.ts:1023`) inputs are exclusively:
pending tasks from the API (`status/assignedTo/dependencyBlocked`,
ordered by `orderKey`), file-claim conflict checks, and unresolved bugs.
The Brain DB adapter (`src/db/brain-db-adapter.ts`) exposes
`getTask/listDiscoveries/listStatusReports` — no swarm reads, matching
ADR-015's API-only boundary (regression-guarded by
`src/brain/__tests__/api-boundary.test.ts`).

### 3. Arm selection — clean

Assignment is claim-based; `domain` defaults to `"general"`
(`brain.ts:1385`) and is recorded, never used for routing (general-purpose
arms per ADR-013). No reputation or evaluation-derived selection exists
in the assignment path.

### 4. Budget enforcement — clean (and mostly not yet built)

The only budget-like bounds are input limits: discovery summarizer
`maxTokens` (`src/brain/discovery-summarizer.ts:32,90`) and the swarm
context-fitting budget (`src/brain/swarm/budget.ts`, evaluation-internal
per ADR-023 §6). Phase 17 cost/budget decisioning is not implemented;
nothing derives spend or model-routing decisions from evaluation output.

### 5. Governance decisions — clean

`src/api/routes/proposals.ts` accepts only arm-submitted arguments
(`armId/position/content/evidence[]`, :321) and signals
(`{weight, reason}` keyed by armId, :384). No endpoint ingests swarm
recommendations or bake-off artifacts as proposal/signal sources. The
workbench inbox is a human-facing projection; human action on it is
outside the automated-decision boundary.

## Documented interim exception

The grandfathered swarm execute mode (ADR-025 §5) applies bounded
operational effects (`prompt_arm`, `stop_arm`, `restart_dev_server`,
`preserve_git_work`, `notify_human`, `comment_task`, `log_discovery`,
bounded `update_task`/`update_bug` corrections) through authenticated,
receipted API adapters. This is the single existing dependency of
operational controls on evaluation output; it is explicitly interim,
must not be extended, and migrates onto the ADR-025 apply gate via the
plan's approved integration.

## Dependency direction

The allowed direction holds everywhere: evaluation consumes production
state (swarm snapshots collect arms/tasks/bugs/discoveries through the
API; the bake-off reads production prompts/templates); production
decisions do not consume evaluation state.

## Evidence

- Import/query audit greps over `src/brain/**`, `src/db/brain-db-adapter.ts`,
  `src/api/routes/proposals.ts` (2026-09-22): zero `brain_swarm_*` /
  bake-off references outside `src/brain/swarm/` and evaluation scripts.
- Suites: evaluation API + runner **45/45** (brain-swarm, swarm-evaluation,
  evaluation-lock, classification-bakeoff — run 2026-09-22); api-boundary
  guard **1/1**.

No code changes required.
