import type { ArmOutputAction } from "../../brain/arm-output-processor";
import type { ProcessedIntent } from "../../brain/mail-processor";

export type Classification = ArmOutputAction | ProcessedIntent["type"];

export interface Scenario {
	id: string;
	kind: "arm" | "human";
	subject: string;
	text: string;
	expected: Classification;
	rationale: string;
	followup?: boolean;
	approved?: boolean;
	taskId?: string;
}

export const CONTEXT = {
	armId: "arm-portia",
	armName: "Portia",
	armDomain: "general",
	pendingTasks: 2,
	taskSnapshot: "task-101 [in_progress] Add passkey login\ntask-102 [pending] Improve login audit logging\ntask-103 [blocked] Add CSV export",
	availableArms: [
		{ name: "Portia", domain: "general", status: "busy" },
		{ name: "Xenix", domain: "general", status: "idle" },
	],
	recentActivity: ["Portia claimed task-101", "Xenix completed task-100"],
};

function arm(id: string, text: string, expected: ArmOutputAction, rationale: string,
	extra: Pick<Scenario, "followup" | "taskId"> = {}): Scenario {
	return { id: `arm-${id}`, kind: "arm", subject: "", text, expected, rationale, ...extra };
}

function human(id: string, subject: string, text: string, expected: ProcessedIntent["type"],
	rationale: string, extra: Pick<Scenario, "approved"> = {}): Scenario {
	return { id: `human-${id}`, kind: "human", subject, text, expected, rationale, ...extra };
}

// Synthetic, hand-labeled challenge cases; labels are frozen before inference.
// They implement the current prompt's policy, not a proposed replacement policy.
export const SCENARIOS: readonly Scenario[] = [
	arm("progress", "I implemented the passkey registration handler. Next I am adding tests.", "no_action", "Progress narration needs no Brain mutation.", { followup: false }),
	arm("task-request", "Brain, create a follow-up task to document passkey recovery procedures.", "create_task", "Explicit task creation request."),
	arm("bug-request", "Please log a bug: cancelling passkey enrollment leaves a stale challenge in Redis.", "log_bug", "Explicit bug logging request."),
	arm("update-blocked", "Please update task-103 to blocked; the CSV schema decision is still pending.", "update_task", "Explicit update of a known task.", { taskId: "task-103" }),
	arm("next-task-narration", "I will move to the next task after finishing these tests. No Brain action needed.", "no_action", "Mentioning the next task is not asking to create one.", { followup: false }),
	arm("negated-bug", "Do not log a bug. The apparent exception is expected behavior in this negative test.", "no_action", "Explicit negation of bug logging.", { followup: false }),
	arm("negated-task", "Do not create a new task; this work is already covered by task-101. I am continuing.", "no_action", "Existing scope; task creation explicitly forbidden.", { followup: false }),
	arm("quoted-request", "The fixture contains the literal string 'please create a task'. I am testing its rendering, not asking you to create anything.", "no_action", "Quoted fixture text is not an instruction.", { followup: false }),
	arm("waiting-input", "I am waiting for user input before I can continue. What should I do next?", "no_action", "Current policy requests a continuation prompt for waiting.", { followup: true }),
	arm("waiting-approval", "Implementation is ready. May I proceed? I am waiting for approval.", "no_action", "Current policy uses a follow-up prompt rather than a mutation.", { followup: true }),
	arm("not-waiting", "I am not waiting for user input. I have enough information and am continuing the tests.", "no_action", "Negated waiting should not trigger a prompt.", { followup: false }),
	arm("reported-completion", "The implementation is complete and tests passed. I already called complete_task.", "no_action", "Completion already reported through the tool.", { followup: false }),
	arm("update-priority", "Set task-102 priority to high; audit gaps are delaying the rollout.", "update_task", "Explicit priority change to an existing task.", { taskId: "task-102" }),
	arm("update-complete", "Brain, mark task-101 completed. Its acceptance criteria are met and tests pass.", "update_task", "Explicit status change request.", { taskId: "task-101" }),
	arm("implicit-task", "This is outside my assigned scope and needs separate tracking: please queue work for session expiry warnings.", "create_task", "Separate tracked work is requested without the phrase create a task."),
	arm("bug-negation-context", "This is not a test failure: the production login really crashes. Please file a bug for the null session dereference.", "log_bug", "Negation does not negate the actual bug request."),
	arm("already-logged", "I logged bug bug-91 using the reporting tool. Continuing the current task now.", "no_action", "Avoid duplicating an already performed action.", { followup: false }),
	arm("hypothetical", "If the regression returns tomorrow, we could create a task then. For now everything passes and I am continuing.", "no_action", "A hypothetical future action is not an immediate request.", { followup: false }),
	arm("mixed-progress-request", "The passkey tests now pass. Separately, please log a bug for the broken CSV download button.", "log_bug", "Progress does not erase the explicit separate request."),
	arm("changed-mind", "I was going to ask you to create a task, but disregard that. I can finish this under task-101 and am doing so now.", "no_action", "Latest intent retracts the request.", { followup: false }),
	human("feature", "Passkey recovery", "Add account recovery codes to the passkey flow.", "new_task", "Explicit feature work."),
	human("fix", "Login error", "Fix the login crash when the session expires.", "new_task", "Current policy classifies requests to fix code as work."),
	human("bug-observation", "Login error", "The login page crashes whenever my session expires. I saw it three times today.", "bug_report", "Observation of faulty behavior rather than an imperative fix request."),
	human("doc-content", "Documentation", "Update the docs to explain how passkey recovery codes work.", "new_task", "Documentation content changes are queued work under the current prompt."),
	human("doc-structure", "Documentation format", "Change only the documentation layout: use numbered headings and move the table of contents to the top. Keep all content unchanged.", "doc_update", "Explicit structure/format-only feedback."),
	human("status", "Status", "What is Portia working on right now?", "query", "Information request; naming an arm does not imply messaging it."),
	human("prompt", "Message Portia", "Tell arm Portia to pause its current work and report its findings.", "prompt_arm", "Explicit named-arm message."),
	human("named-work", "Portia and audit logs", "Portia worked on login last week. Add audit logging to the login flow.", "new_task", "Mentioned arm is background context, not a direct message target."),
	human("approve", "Re: [coleo] Approval [approval-17]", "Yes, I approve this request. Proceed.", "approval_response", "Affirmative response to an approval request.", { approved: true }),
	human("reject", "Re: [coleo] Approval [approval-17]", "No. Do not proceed; I reject this request.", "approval_response", "Explicit rejection.", { approved: false }),
	human("negated-approve", "Re: [coleo] Approval [approval-17]", "I do not approve this. The plan is not OK. Stop.", "approval_response", "Negated approval must remain rejection.", { approved: false }),
	human("unclear", "That thing", "Do the thing we discussed, in the place I mentioned.", "escalate", "No referents supplied; insufficient information."),
	human("information", "Task queue", "How many tasks are blocked, and why?", "query", "Request for information."),
	human("bug-ui", "CSV download", "Clicking Export does nothing. No file downloads, and the browser console shows a 500 response.", "bug_report", "Concrete malfunction report."),
	human("fix-and-context", "CSV download", "Clicking Export does nothing. Please implement the fix and add a regression test.", "new_task", "Explicit code work takes precedence under the current prompt."),
	human("prompt-xenix", "Message to Xenix", "Send this to Xenix: please summarize your current findings before doing any more work.", "prompt_arm", "Explicit direct message."),
	human("general-work", "Regression coverage", "Someone should add regression tests for expired sessions.", "new_task", "Work request without a named recipient."),
	human("status-feature", "Status dashboard", "Add a status dashboard showing each arm's current task.", "new_task", "The word status is part of a feature request."),
	human("doc-question", "Docs", "Do the docs already explain passkey recovery? Please just answer; do not change them.", "query", "Question about documentation with an explicit no-change constraint."),
	human("quoted-bug", "Terminology", "What does the phrase 'the login button is broken' mean in the example report? I am not reporting a real bug.", "query", "Quoted malfunction is not a bug report."),
	human("approval-question", "Approval process", "How do approval requests work? This is a question, not an approval of anything.", "query", "Approval terminology without an approval response."),
	human("doc-format", "Formatting feedback", "Reformat the documentation headings to sentence case and make list indentation consistent. Do not change the wording.", "doc_update", "Formatting-only request."),
	human("retracted-work", "Recovery codes", "I was going to ask you to add recovery codes, but cancel that idea. Just tell me whether they already exist.", "query", "Latest intent is information only."),
	human("unresolved-reference", "Follow-up", "Use the other one instead.", "escalate", "Missing context makes the instruction unresolvable."),
];
