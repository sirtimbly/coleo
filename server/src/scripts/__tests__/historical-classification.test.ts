import { describe, expect, it } from "bun:test";
import { buildState, HUMAN_LABELS, isDirectHumanMessage } from "../historical-classification/history";
import { assemble, clarificationReasons, detailQuestions, routingQuestions, selectedActions,
	validateCurrentAnswers, validateJevAnswers } from "../historical-classification/queries";
import { score } from "../historical-classification/report";
import { TASK_FIELDS } from "../historical-classification/schema";
import type { HistoricalMessage } from "../historical-classification/history";
import type { Answers } from "../historical-classification/queries";
import type { Result } from "../historical-classification/report";
import type { MailMessage } from "../../mail/maildir";

const message: HistoricalMessage = {
	id: "test", messageId: "message-test", date: "2026-02-01T00:00:00Z", subject: "Re: Arm attention",
	body: "Please prompt it.\n\n---\nIn reply to: alert\n> The arm \"default\" needs attention.\n> task-123 is blocked.",
	headers: {}, sourcePath: "test.eml",
};

describe("historical human classification", () => {
	it("keeps quoted context separate and resolves candidate identifiers without future database state", () => {
		const state = buildState(message);
		expect(state.authoredText).toBe("Please prompt it.");
		expect(state.quotedContext).toContain("task-123");
		expect(Object.values(state.targets)).toContain("default");
		expect(Object.values(state.targets)).toContain("task-123");
		expect(JSON.stringify(state)).not.toContain("humanLabel");
	});

	it("excludes Brain notifications and arm mail from the direct-human corpus", () => {
		const base: MailMessage = { id: "test", subject: "test", date: new Date(), body: "test",
			flags: { seen: true, replied: false, flagged: false, draft: false, trashed: false },
			from: "human@coleo.local", to: "brain@coleo.local", headers: { "x-coleo-type": "human-message" } };
		expect(isDirectHumanMessage(base)).toBe(true);
		expect(isDirectHumanMessage({ ...base, headers: {}, from: "human@local" })).toBe(true);
		expect(isDirectHumanMessage({ ...base, from: "arm@coleo.local", headers: {} })).toBe(false);
		expect(isDirectHumanMessage({ ...base, from: "brain@coleo.local" })).toBe(false);
		expect(isDirectHumanMessage({ ...base, headers: { "x-coleo-type": "bug-report" } })).toBe(false);
	});

	it("asks schema fields only after selected actions and never asks a model to invent system fields", () => {
		const questions = detailQuestions(["new_task"], buildState(message));
		expect(questions.s0_priority).toBeDefined();
		expect(questions.s0_blockedCategory).toBeDefined();
		expect(questions.s0_context).toBeDefined();
		expect(questions.s0_createdAt).toBeUndefined();
		expect(questions.s0_id).toBeUndefined();
		expect(questions.s0_archived).toBeUndefined();
	});

	it("preserves unknown optional fields without creating unnecessary follow-ups", () => {
		const state = buildState(message);
		const questions = detailQuestions(["new_task"], state);
		const details = Object.fromEntries(Object.keys(questions).map((key) => [key, { choice: "not_provided" }]));
		const route: Answers = { include_new_task: { choice: "new_task", probabilities: { new_task: .95 } },
			readiness: { choice: "ready" } };
		const proposals = assemble(["new_task"], route, details, state);
		expect(Object.keys(proposals[0]!.fields)).toHaveLength(Object.keys(TASK_FIELDS).length + 1);
		expect(proposals[0]!.fields.createdAt!.status).toBe("system");
		expect(clarificationReasons(proposals, route, .8)).toEqual([]);
	});

	it("requires resolution of a missing existing target and exposes threshold behavior", () => {
		const proposal = { action: "prompt_arm" as const, probability: .7, fields: {
			target: { mode: "evidence" as const, status: "unclear" as const, note: "missing target" },
		} };
		expect(clarificationReasons([proposal], {}, .8)).toEqual(["slot_0:low_action_probability", "slot_0:unresolved_target"]);
		expect(clarificationReasons([proposal], {}, .5)).toEqual(["slot_0:unresolved_target"]);
	});

	it("rejects incomplete answer maps and never interprets a missing action as no_action", () => {
		expect(() => validateCurrentAnswers({}, routingQuestions())).toThrow();
	});

	it("retains separate feature and bug actions without duplicate slots", () => {
		const answers = Object.fromEntries(Object.keys(routingQuestions()).map((key) =>
			[key, key === "readiness" ? "ready" : "no_action"]));
		answers.include_new_task = "new_task";
		answers.include_bug_report = "bug_report";
		expect(selectedActions(validateCurrentAnswers(answers, routingQuestions()))).toEqual(["new_task", "bug_report"]);
		answers.include_new_task = "Create new tracked implementation work or documentation content work.";
		expect(() => validateCurrentAnswers(answers, routingQuestions())).toThrow();
	});

	it("rejects unusable JEV probabilities before confidence-based follow-up decisions", () => {
		const questions = { decision: { type: "choice" as const, instructions: "Choose", criteria: { yes: "Yes", no: "No" } } };
		const answer = { type: "choice", choice: "yes", confidence: .9, probabilities: { yes: .9 } };
		expect(() => validateJevAnswers({ answers: { decision: answer } }, questions)).toThrow();
		expect(() => validateJevAnswers({ answers: { decision: { ...answer, probabilities: { yes: .9, no: .9 } } } }, questions)).toThrow();
	});

	it("uses target probability as well as action probability for proposed follow-ups", () => {
		const proposal = { action: "prompt_arm" as const, probability: .99, fields: {
			target: { mode: "evidence" as const, status: "selected" as const, value: "default", probability: .6, note: "target" },
		} };
		expect(clarificationReasons([proposal], {}, .8)).toEqual(["slot_0:low_target_probability"]);
		expect(clarificationReasons([proposal], {}, .5)).toEqual([]);
	});

	it("scores user-labeled fields as well as action coverage", () => {
		const result: Result = { messageId: "human-94966268e90e", backend: "jev", status: "ok", elapsedMs: 1,
			routingMs: 1, detailsMs: 0, route: {}, followupReasons: [], stages: [],
			actions: [{ action: "reprioritize_task", fields: {} }] };
		expect(score(result, HUMAN_LABELS[result.messageId]!)).toEqual({ actions: true, fields: false });
	});
});
