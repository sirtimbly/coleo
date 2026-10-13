import type { Task } from "../../api/routes/tasks";
import type { Bug } from "../../api/routes/bugs";

export interface FieldSpec {
	mode: "choice" | "evidence" | "system" | "derived" | "unsupported";
	description: string;
	options?: readonly string[];
}
const choice = (description: string, options: readonly string[]): FieldSpec => ({ mode: "choice", description, options });
const evidence = (description: string): FieldSpec => ({ mode: "evidence", description });
const system = (description: string): FieldSpec => ({ mode: "system", description });
const derived = (description: string): FieldSpec => ({ mode: "derived", description });
const unsupported = (description: string): FieldSpec => ({ mode: "unsupported", description });

// Compile-time exhaustive coverage of the actual API models. These are extraction
// assessments, not writable API payloads. API constraints still apply to mutations.
export const TASK_FIELDS = {
	id: system("Generated for creation; existing update target resolved separately."),
	subject: evidence("Requested task subject; select source evidence, not an invented summary."),
	description: evidence("Requested work and acceptance criteria; preserve relevant source text."),
	status: choice("Explicitly requested task status", ["draft", "pending", "claimed", "in_progress", "completing", "completed", "failed", "blocked", "cancelled"]),
	priority: choice("Explicit priority; highest is critical, lowest is low. Do not infer urgency from tone alone.", ["critical", "high", "normal", "low"]),
	sourceType: derived("email: these messages entered through the human mail ingress."),
	sourceRef: derived("Original message ID."),
	phase: evidence("Explicit project phase identifier."),
	domain: evidence("Explicit domain; free-form schema, not restricted to a fabricated enum."),
	classification: evidence("Explicit task classification; schema permits arbitrary strings."),
	assignedTo: evidence("Explicit requested assignee identifier/name, resolved before use."),
	dependencyBlocked: choice("Explicitly blocked by unfinished dependencies", ["true", "false"]),
	assignedArmName: derived("Display name joined from the arm record."),
	consensusStatus: system("Coordinator-maintained legacy consensus state."),
	planLineUid: system("Plan synchronization identifier."),
	sortOrder: derived("Translate requested relative queue position to ordering in code."),
	orderKey: derived("Fractional ordering key computed from neighbors in code."),
	commentCount: system("Computed count of comments."),
	lastCommentAt: system("Actual comment timestamp."),
	mailThreadId: derived("Thread/reference headers from the message."),
	progress: evidence("Explicit numeric progress percentage; validate range in code."),
	createdAt: system("Creation timestamp."),
	updatedAt: system("Mutation timestamp."),
	completedAt: system("Actual completion transition timestamp."),
	blockedAt: system("Actual blocked transition timestamp."),
	blockedReason: evidence("Explicit reason work cannot proceed."),
	blockedCategory: choice("Category of an explicitly described blocker", ["dependency", "bug", "file_claim", "environment", "human", "arm", "planning", "unknown"]),
	blockedRecheckAt: evidence("Explicit requested recheck time; requires deterministic date parsing."),
	blockedLastCheckedAt: system("Last actual blocked-work check."),
	blockedReviewCount: system("Actual review count."),
	blockedNeedsHuman: choice("Explicitly requires human input to resolve a blocker", ["true", "false"]),
	blockedHumanNotifiedAt: system("Actual notification timestamp."),
	blockedReviewArmId: system("Coordinator's reviewer assignment."),
	blockedReviewStartedAt: system("Actual review start timestamp."),
	claimedAt: system("Actual claim timestamp."),
	startedAt: system("Actual work start timestamp."),
	dueDate: evidence("Explicit due date; preserve source wording and resolve against message date."),
	artifacts: evidence("Explicit artifact paths or URLs; structured array assembled from source evidence."),
	context: evidence("Explicit contextual information/attachments; arbitrary object needs separate parsing."),
	metadata: evidence("Explicit metadata such as tags; arbitrary object needs separate parsing and validation."),
	checklist: evidence("Explicit checklist/acceptance criteria; text evidence only, item IDs/timestamps are system-owned."),
} satisfies Record<keyof Task, FieldSpec>;

export const BUG_FIELDS = {
	id: system("Generated for creation; existing target resolved separately."),
	title: evidence("Bug title evidence; no synthesized title."),
	description: evidence("Observed malfunction, reproduction steps and expected behavior."),
	source: derived("human_reported for this corpus."),
	sourceArmId: evidence("Explicit originating arm identifier, if supplied."),
	sourceTaskId: evidence("Explicit originating task identifier, if supplied."),
	status: choice("Explicitly requested bug status", ["open", "investigating", "fixing", "verifying", "resolved", "closed"]),
	priority: choice("Explicit bug priority; highest is critical, lowest is low", ["low", "medium", "high", "critical"]),
	assigneeArmId: evidence("Explicit requested bug assignee identifier/name."),
	assigneeArmName: derived("Display name joined from arm record."),
	blockers: evidence("Explicit blocking task identifiers; resolve array from evidence."),
	errorDetails: evidence("Explicit stack traces, errors or logs. Creation supports this field; PATCH currently does not."),
	resolution: evidence("Explicit requested resolution record."),
	sortOrder: derived("Relative queue ordering encoded in code."),
	metadata: evidence("Explicit tags or metadata; free-form object requires separate parsing."),
	createdAt: system("Creation timestamp."),
	updatedAt: system("Mutation timestamp."),
	resolvedAt: system("Actual resolution timestamp."),
	humanNotified: system("Actual notification delivery state."),
	archived: unsupported("Managed by separate archive/unarchive endpoints, not offered as an action in this experiment."),
} satisfies Record<keyof Bug, FieldSpec>;

export const ACTIONS = {
	new_task: "Create new tracked implementation work or documentation content work.",
	bug_report: "Create a bug report for a malfunction, including an explicit request to log a bug.",
	update_task: "Change existing task content, status, dependencies or acceptance criteria.",
	cancel_task: "Cancel an existing task.",
	reprioritize_task: "Change an existing task's priority or position in the work queue.",
	update_bug: "Change an existing bug's content, status, assignment or resolution.",
	cancel_bug: "Close an existing bug without claiming a fix; needs a reason and resolved target.",
	reprioritize_bug: "Change an existing bug's priority or queue position.",
	doc_update: "Change documentation structure or formatting.",
	update_plan: "Make specified changes to the project plan itself.",
	query: "Answer a substantive request for status or information.",
	approval_response: "Explicitly grant or reject a previous approval; reply subject alone is not approval.",
	prompt_arm: "Send an instruction to a specific arm, identified directly or in quoted thread context.",
	pause_brain: "Pause the running brain now.",
	resume_brain: "Resume the paused brain now.",
	stop_arm: "Stop a specific running arm now.",
	restart_arm: "Recover/restart a specific arm now; dispatch strategy must be resolved separately.",
	request_clarification: "Essential intent or target is missing and cannot be resolved from the supplied context.",
	no_action: "Acknowledgement, narration, a retracted request, or no further distinct requested action.",
} as const;
export type Action = keyof typeof ACTIONS;

export const COMMON_FIELDS: Record<string, FieldSpec> = {
	target: evidence("Exact existing task/bug/arm/approval/document/plan target. Use supplied context, never invent an ID."),
	queuePosition: choice("Explicit requested queue placement", ["top", "bottom", "before_target", "after_target"]),
	approval: choice("Explicit approval polarity", ["approve", "reject"]),
	instruction: evidence("Actual requested arm instruction, question, approval comment, document/plan change or clarification need."),
};

export const POLICY = `Classify a direct message from a human to Coleo Brain.
Only authored text expresses new instructions; quoted replies provide context and identifiers, not new commands.
For each offered action type, decide independently whether this message requests that action. An omitted type is no_action for that question.
Include each action type at most once. Several requests of the same type are grouped for review, not automatically split into executable mutations.
Do not duplicate one request as several actions. Split a genuinely separate feature request and bug report.
An explicit request to log a bug is bug_report, even if it describes work to fix it.
Requests to change software capabilities are tasks, not immediate operational controls: adding a kill button is not stop_arm.
Reprioritizing and moving one task is one reprioritize_task action; it is not an approval response just because the subject mentions approval.
Resolve pronouns from the quoted thread. A lead-in like "what's wrong with it? can you prompt it?" is only prompt_arm unless a separate substantive explanation is requested.
Do not create work from quoted history or already completed actions. Do not treat an incidental mention of future planning as a request to change the plan now.
Do not ask about optional fields such as domain or due date. Missing optional data is not a reason to clarify.
Unknown required targets may need clarification; never invent a record. All outputs are proposals, never commands to execute.`;

export function fieldsFor(action: Action): Record<string, FieldSpec> {
	const common: Record<string, FieldSpec> = {};
	if (["update_task", "cancel_task", "reprioritize_task", "update_bug", "cancel_bug", "reprioritize_bug",
		"prompt_arm", "stop_arm", "restart_arm", "approval_response", "doc_update", "update_plan"].includes(action)) {
		common.target = COMMON_FIELDS.target!;
	}
	if (["new_task", "update_task", "cancel_task", "reprioritize_task"].includes(action)) {
		return { ...TASK_FIELDS, ...common, queuePosition: COMMON_FIELDS.queuePosition! };
	}
	if (["bug_report", "update_bug", "cancel_bug", "reprioritize_bug"].includes(action)) {
		return { ...BUG_FIELDS, ...common, queuePosition: COMMON_FIELDS.queuePosition! };
	}
	if (action === "approval_response") common.approval = COMMON_FIELDS.approval!;
	if (action === "prompt_arm") {
		common.prompt = evidence("Prompt text requested for the selected arm; copy grounded evidence or mark as needing generation.");
		common.interrupt = choice("Explicit request to interrupt current work before prompting", ["true", "false"]);
		common.attachments = derived("Message attachment descriptors copied from headers; never infer local file contents.");
	}
	if (action === "restart_arm") {
		common.workdir = evidence("Explicit recovery working directory.");
		common.provider = evidence("Explicit recovery model provider.");
		common.model = evidence("Explicit recovery model name.");
		common.agentId = evidence("Explicit recovery host agent ID.");
		common.allowLocalFallback = choice("Explicit request to allow local fallback during recovery", ["true", "false"]);
	}
	if (!["no_action", "pause_brain", "resume_brain"].includes(action)) common.instruction = COMMON_FIELDS.instruction!;
	return common;
}
