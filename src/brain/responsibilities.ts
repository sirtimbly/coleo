/** Shared, browser-safe catalog. Controls describe the exact handler scope, not full feature parity. */
export const BUILTIN_RESPONSIBILITIES = ["followups", "new-bugs", "task-state", "idle-work", "stalled", "blocked-review", "human-messages"] as const;
export type BuiltinResponsibility = typeof BUILTIN_RESPONSIBILITIES[number];
export const SWARM_ACTION_IDS = ["stop_arm", "prompt_arm", "update_task", "comment_task", "log_discovery", "create_bug", "update_bug", "notify_human", "restart_dev_server", "preserve_git_work"] as const;
export type SwarmActionId = typeof SWARM_ACTION_IDS[number];
export type ActionMode = "inherit" | "shadow" | "off";
export interface BrainResponsibilitySettings {
  responsibilityEnabled?: Partial<Record<BuiltinResponsibility, boolean>>;
  swarmActionModes?: Partial<Record<SwarmActionId, ActionMode>>;
}
export function builtinEnabled(settings: BrainResponsibilitySettings, id: BuiltinResponsibility): boolean {
  return settings.responsibilityEnabled?.[id] !== false;
}
export function validateResponsibilitySettings(settings: BrainResponsibilitySettings): void {
  for (const [field, keys, valid] of [
    ["responsibilityEnabled", BUILTIN_RESPONSIBILITIES, (value: unknown) => typeof value === "boolean"],
    ["swarmActionModes", SWARM_ACTION_IDS, (value: unknown) => ["inherit", "shadow", "off"].includes(String(value))],
  ] as const) {
    const map = settings[field];
    if (map === undefined) continue;
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error(`${field} must be an object`);
    for (const [key, value] of Object.entries(map)) {
      if (!(keys as readonly string[]).includes(key) || !valid(value)) throw new Error(`Invalid Brain setting: ${field}.${key}`);
    }
  }
}
export interface BrainResponsibility {
  id: string; title: string; today: string; fit: string; gap: string; example: string;
  builtinLabel: string | null; scope: string; actions: SwarmActionId[]; templates: string[];
}
export const BRAIN_RESPONSIBILITIES: BrainResponsibility[] = [
  {
    "id": "followups",
    "title": "Follow-up prompts from arm messages",
    "today": "The Brain reads assistant output and stuck-arm signals to decide whether to send another instruction. These paths combine rules, runtime checks, and sometimes model interpretation. A prompt may ask an arm to investigate a problem, report progress, or continue work.",
    "fit": "JEV already evaluates whether a prompt is warranted across the shared window. It can select a real arm and one of six prompt purposes: investigate, report progress, continue the task, verify a fix, record completion, or review a conflict. The existing adapter sends a non-interrupting prompt with quoted evidence.",
    "gap": "The adapter assembles a fixed instruction; it does not write a tailored explanation or answer an arbitrary technical question. The current snapshot also lacks some live harness and startup-grace information used by legacy handlers. A shared prompt endpoint does not make every prompting workflow equivalent.",
    "example": "An arm says, \u201cThe failing test looks unrelated; I have not investigated it.\u201d JEV could choose investigate and cite that message. If another arm has already identified the cause and the Brain already prompted this arm, it should wait or mark the issue handled.",
    "builtinLabel": "Assistant-output follow-up prompts",
    "scope": "Only follow-up prompts from assistant-output classification are switched here. Startup, human requests, health monitoring, and work dispatch have separate paths. Turning this off still allows the classifier to create tasks or bugs.",
    "actions": [
      "prompt_arm"
    ],
    "templates": [
      "arm-output-processor-system-prompt.jinja"
    ]
  },
  {
    "id": "new-bugs",
    "title": "Recognize and log bugs from arm output",
    "today": "Assistant-output interpretation can classify a message as a bug report and create a bug. It shares a processor with task creation and task updates, so turning off the entire processor removes more than bug detection.",
    "fit": "JEV has an implemented create_bug action. It can examine multiple arms\u2019 messages alongside existing bugs, decide that a malfunction is new, select evidence and priority, and call the existing bug-creation endpoint.",
    "gap": "The title and description are built from source evidence and a fixed template. They may be less useful than a focused description with reproduction steps. Coverage is bounded, so the supplied set of bugs may be incomplete; execution is blocked when configured limits are exceeded.",
    "example": "Two arms encounter the same API error. The desired result is one bug with useful evidence, not one report per arm. A routine tool failure followed by a successful retry should usually produce no bug.",
    "builtinLabel": "Infer bugs from assistant output",
    "scope": "Only inferred log_bug decisions from assistant output are switched here. Explicit bug reports and task-blocking rules continue to work.",
    "actions": [
      "create_bug"
    ],
    "templates": [
      "arm-output-processor-system-prompt.jinja",
      "human-bug-high-priority.jinja",
      "human-bug-medium-escalation.jinja",
      "human-bug-report-confirmation.jinja"
    ]
  },
  {
    "id": "findings",
    "title": "Record discoveries and task discussion findings",
    "today": "Arms can explicitly submit discoveries and task discussion comments through existing APIs. The Brain also has access to activity and task state that may contain useful findings nobody has recorded.",
    "fit": "Both log_discovery and comment_task are implemented. JEV can notice that a finding in the activity window is worth retaining and attach evidence to a discovery or to a selected task discussion.",
    "gap": "Discovery creation currently records a generic pattern with informational severity. Comment text is a fixed wrapper around evidence. The snapshot does not include complete task discussion history, so JEV cannot reliably recognize every point already discussed.",
    "example": "An arm discovers that a recurring test failure depends on a shared fixture. JEV could preserve that observation for other arms. If the arm already submitted the same discovery, the evaluator should not submit it again.",
    "builtinLabel": null,
    "scope": "Existing lifecycle and explicit reporting paths remain active. JEV adds only the actions listed here.",
    "actions": [
      "log_discovery",
      "comment_task",
      "notify_human"
    ],
    "templates": [
      "human-discovery.jinja",
      "human-doc-updated.jinja",
      "human-file-change.jinja",
      "human-issues-found.jinja",
      "human-tool-discovered.jinja"
    ]
  },
  {
    "id": "task-state",
    "title": "Correct task priority or blocked/pending state",
    "today": "Task-management handlers interpret output, maintain work state, enforce blockers, and apply lifecycle changes. The existing assistant-output schema supports more fields and statuses than the JEV adapter.",
    "fit": "JEV can propose a task priority change or a correction between pending and blocked. Execution checks the target version and prevents status changes that override assignment, planning blocks, dependency blocks, or human-review blocks.",
    "gap": "There is no JEV adapter for queue position, subject or description edits, assignment, completion, failure, or cancellation. The snapshot contains selected task fields and a bounded set of tasks, not every task and relationship in the system.",
    "example": "A pending, unassigned task has fresh evidence of a genuine blocker. JEV may mark it blocked. \u201cMove this refactoring task to the very bottom\u201d is not equivalent: priority alone cannot change its queue order.",
    "builtinLabel": "Infer task updates from assistant output",
    "scope": "Only inferred update_task decisions from assistant output are switched here. Task creation, claims, completion and explicit requests remain on their normal paths. JEV can only adjust priority and guarded pending/blocked state.",
    "actions": [
      "update_task"
    ],
    "templates": [
      "arm-output-processor-system-prompt.jinja"
    ]
  },
  {
    "id": "existing-bugs",
    "title": "Update existing bugs",
    "today": "Bug workflows track state, priority, relationships to blocked tasks, and escalation. Some actions change the bug itself; others change tasks or notify the human.",
    "fit": "JEV can select an existing bug, append evidence to its description, and optionally change priority. The patch uses a version precondition so a newer edit is not silently overwritten.",
    "gap": "The adapter cannot resolve or reopen a bug, assign it, maintain blocker relationships, or run the complete escalation process. The snapshot lacks the full relationship and escalation history those workflows use.",
    "example": "A second arm reports a reproducible instance of an existing bug. JEV can attach it. A statement that the bug is fixed should lead to verification; the current adapter cannot validate and close the bug.",
    "builtinLabel": null,
    "scope": "Existing lifecycle and explicit reporting paths remain active. JEV adds only the actions listed here.",
    "actions": [
      "update_bug"
    ],
    "templates": [
      "bug-assignment-prompt.jinja",
      "human-bug-resolved.jinja"
    ]
  },
  {
    "id": "idle-work",
    "title": "Nudge idle arms toward available work",
    "today": "promptIdleArms() loads pending/claimed tasks, determines which are available to an arm, checks live harness state and recent activity, and consults the arm state machine. It can then prompt an arm to fetch work.",
    "fit": "JEV can recognize an idle arm with relevant recent evidence and send a continue-task or progress prompt. It can also consider other arms\u2019 activity and previous Brain interventions.",
    "gap": "The JEV snapshot does not provide the complete eligible backlog, all queue ordering and ownership context, or all runtime checks. Old, unassigned pending tasks may be omitted. With no non-Brain events in the window, the evaluator returns without making decisions.",
    "example": "A task has waited overnight and an idle arm has been silent for ten minutes. A five-minute message window may contain neither the task nor usable evidence to trigger a prompt.",
    "builtinLabel": "Prompt idle arms about available work",
    "scope": "Turning this off suppresses the periodic available-work nudge. Initial task assignment and normal work dispatch remain active. JEV does not see the full backlog and is not a replacement scheduler.",
    "actions": [
      "prompt_arm"
    ],
    "templates": [
      "arm-tasks-available-prompt.jinja",
      "initial-arm-prompt.jinja"
    ]
  },
  {
    "id": "stalled",
    "title": "Detect stalled, looping, or silent arms",
    "today": "Legacy stuck detection, idle-loop detection, and a separately scheduled health monitor inspect activity and runtime state. These paths can escalate through prompts and other interventions; some also synchronize state or detect completion.",
    "fit": "JEV can compare messages across arms and distinguish an unresolved loop from productive progress or a problem another arm already handled. Prompt, stop, and human-notification adapters are available.",
    "gap": "Silence is not fully represented as structured evidence. JEV needs last productive activity, last heartbeat, runtime state, startup grace, and elapsed time since previous interventions. A rolling message window alone loses long-running incidents, and an empty window currently skips evaluation.",
    "example": "An arm repeats the same failed command five times: JEV has evidence to judge a loop. An arm emits nothing for twenty minutes: JEV needs explicit elapsed-time and runtime facts, not merely an absence of messages.",
    "builtinLabel": "Poll-loop stuck analysis and idle-loop interventions",
    "scope": "This controls semantic stuck analysis and idle-loop interventions in the poll loop. Runtime observation, silent-completion detection and the separate health-monitor timer remain active. This is not exclusive JEV ownership of arm health.",
    "actions": [
      "prompt_arm",
      "stop_arm",
      "notify_human"
    ],
    "templates": [
      "stuck-analyzer-system-prompt.jinja",
      "stuck-analyzer-user-prompt.jinja",
      "arm-generic-nudge.jinja",
      "arm-loop-compact-nudge.jinja",
      "human-arm-idle-loop.jinja",
      "human-arm-stuck.jinja",
      "human-arm-zombie-killed.jinja"
    ]
  },
  {
    "id": "recovery",
    "title": "Stop or recover an unhealthy arm",
    "today": "Existing health/stuck handling can prompt, request compaction, escalate, and stop or mark arms stopped. Permission responses are another path. These operations have different effects even when they all look like \u201crecovery.\u201d",
    "fit": "JEV has a stop_arm adapter that calls the existing kill endpoint, checks the target version, and requires a higher execution score. Prompt and stop share an intervention scope to prevent immediate repeated intervention.",
    "gap": "There is no equivalent JEV recovery sequence for compaction, restart, or permission decisions. Some existing \u201ckill\u201d callbacks update recorded arm state, whereas the JEV adapter calls the kill endpoint. Those are not necessarily the same operation.",
    "example": "A context-exhausted arm may need compaction rather than termination. JEV\u2019s current choices can propose a follow-up or stop, but they do not implement the full compact-and-observe sequence.",
    "builtinLabel": null,
    "scope": "Existing lifecycle and explicit reporting paths remain active. JEV adds only the actions listed here.",
    "actions": [
      "stop_arm",
      "restart_dev_server",
      "preserve_git_work"
    ],
    "templates": [
      "arm-api-restart-prompt.jinja",
      "human-infra-issues.jinja"
    ]
  },
  {
    "id": "completion",
    "title": "Detect silent task completion",
    "today": "checkStuckArms() includes a path for detecting an arm that appears finished without having called the normal completion tool. Existing handling can then enter the task-completion workflow.",
    "fit": "JEV can infer that a follow-up is warranted and prompt the arm to record completion or verify a fix. This is useful assistance but does not itself complete the task.",
    "gap": "The swarm action set has no complete_task action. It lacks a dedicated contract for validation results, completion artifacts, and downstream lifecycle effects. A message saying \u201cdone\u201d is not sufficient proof.",
    "example": "An arm reports \u201cAll tests pass; the change is committed\u201d and goes idle. JEV can ask it to record completion. It cannot currently confirm those claims and safely finalize the task itself.",
    "builtinLabel": null,
    "scope": "Existing lifecycle and explicit reporting paths remain active. JEV adds only the actions listed here.",
    "actions": [
      "prompt_arm"
    ],
    "templates": [
      "arm-prompt-complete-task.jinja",
      "human-task-completed.jinja",
      "human-review-needed.jinja",
      "human-verification-needed.jinja"
    ]
  },
  {
    "id": "blocked-review",
    "title": "Review and escalate blocked tasks",
    "today": "reviewBlockedTasks() selects due tasks, chooses idle review arms, records review ownership and a lease, and reads discussion context. Escalation handling considers blocker age, linked bugs, and previous escalation levels.",
    "fit": "JEV can see some blocked-task and bug state, recommend a priority correction, add a discussion finding, or notify the human through an arm-associated candidate.",
    "gap": "It does not schedule reviews, reserve review arms, renew leases, or maintain escalation stages. The snapshot omits important review dates, discussions, bug-blocker relationships, and escalation records. Human notification candidates are currently arm-based, not task-based.",
    "example": "A task has been blocked for two days by a bug. The existing workflow can assign an available arm to review it. JEV may recognize urgency, but it cannot currently create that review reservation and maintain its lifecycle.",
    "builtinLabel": "Blocked-task reviews and escalation",
    "scope": "Turning this off skips timed blocked-task review assignments and escalation. JEV has no equivalent review-lease or scheduling workflow.",
    "actions": [
      "update_task",
      "comment_task",
      "notify_human"
    ],
    "templates": [
      "arm-review-blocked-task.jinja",
      "human-task-blocked.jinja",
      "human-task-deferred.jinja",
      "human-task-blocked-by-bugs.jinja",
      "human-task-resumed.jinja"
    ]
  },
  {
    "id": "human-messages",
    "title": "Classify direct human messages",
    "today": "processHumanMail() interprets direct messages and routes the resulting intents. It owns a different responsibility from scanning a swarm activity window: carrying out what the human asked, with the right thread context.",
    "fit": "The earlier JEV classification experiments establish a place to compare message interpretation. Typed choices are suitable for identifying one or more intended actions and then selecting their arguments.",
    "gap": "Those experiments are not the live swarm evaluator\u2019s human-message router. A replacement needs quoted-thread context, multi-action extraction, entity resolution, field extraction for the selected schemas, and a follow-up policy for ambiguity. The current swarm schema cannot express all of those actions.",
    "example": "\u201cMove that refactoring task to low priority and the bottom of the queue\u201d requires resolving the quoted task, changing priority, and changing queue position. The swarm adapter can only cover the priority part.",
    "builtinLabel": "Process incoming human messages",
    "scope": "Turning this off leaves incoming mail unprocessed until re-enabled. JEV swarm evaluation does not replace human-message classification. The historical classifier remains an experiment.",
    "actions": [],
    "templates": [
      "mail-processor-system-prompt.jinja",
      "human-mail-escalate.jinja",
      "human-approval-request.jinja",
      "human-status-report.jinja",
      "human-task-queued-busy.jinja"
    ]
  },
  {
    "id": "foundation",
    "title": "Planning, claims, dependencies, NATS, and infrastructure",
    "today": "Planning gates decide whether work may start. Queue consumers ingest explicit messages. Claims and dependencies constrain task eligibility. State transitions, persistence, and infrastructure checks keep the swarm coherent and available.",
    "fit": "JEV can contribute selected judgments inside these workflows\u2014for example, whether evidence warrants a follow-up. It depends on the same infrastructure to receive events, inspect state, record decisions, and execute an action.",
    "gap": "The evaluator is not a substitute for message delivery, claim ownership, dependency enforcement, durable writes, or service recovery. Dev-server restart and Git preservation have choice types but remain proposals; verified execution adapters are absent.",
    "example": "A task depends on unfinished work. Code should keep it ineligible regardless of which model thinks it looks important. A failed dev server can be noticed by JEV, but recognition alone does not restart the right process safely.",
    "builtinLabel": null,
    "scope": "Existing lifecycle and explicit reporting paths remain active. JEV adds only the actions listed here.",
    "actions": [],
    "templates": [
      "plan-evaluation-system-prompt.jinja",
      "plan-evaluation-user-prompt.jinja",
      "plan-readiness-system-prompt.jinja"
    ]
  }
];
export const JEV_TEMPLATES = ["jev-swarm-policy.jinja", "jev-swarm-questions.jinja"];
export const BRAIN_TEMPLATE_NAMES = [...new Set([...BRAIN_RESPONSIBILITIES.flatMap(item => item.templates), ...JEV_TEMPLATES])];
