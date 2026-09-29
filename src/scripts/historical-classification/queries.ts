import { z } from "zod";
import { ACTIONS, POLICY, fieldsFor } from "./schema";
import type { Action, FieldSpec } from "./schema";
import type { MessageState } from "./history";

export interface Question {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}
export type Questions = Record<string, Question>;
export interface TypedAnswer {
	choice: string;
	probabilities?: Record<string, number>;
	confidence?: number;
}
export type Answers = Record<string, TypedAnswer>;
export interface FieldAssessment {
	mode: FieldSpec["mode"];
	status: "selected" | "not_provided" | "unclear" | "system" | "derived" | "unsupported";
	value?: string;
	evidenceKey?: string;
	probability?: number;
	note: string;
}
export interface ActionProposal {
	action: Action;
	probability?: number;
	fields: Record<string, FieldAssessment>;
}
export function routingQuestions(): Questions {
	const questions: Questions = {};
	for (const [action, description] of Object.entries(ACTIONS)) {
		if (action === "no_action") continue;
		questions[`include_${action}`] = {
			type: "choice", instructions: `${POLICY}\nDoes authoredText request the specific action ${action}: ${description}? Choose ${action} only when this action is actually requested. Otherwise choose no_action. Other requested action types are evaluated independently; do not select this action merely because another type is requested.`,
			criteria: { [action]: description, no_action: `This message does not request ${action}.` },
		};
	}
	questions.readiness = { type: "choice", instructions: `${POLICY}\nIs a clarification essential before interpreting the requested action(s)? Missing optional schema fields do not require clarification.`,
		criteria: { ready: "Enough context to interpret the request.", clarify: "Essential intent or target is unresolved." } };
	return questions;
}

export function selectedActions(answers: Answers): Action[] {
	const actions: Action[] = [];
	for (const action of Object.keys(ACTIONS)) {
		if (action === "no_action") continue;
		const value = answers[`include_${action}`]?.choice;
		if (value !== action && value !== "no_action") throw new Error(`Invalid action choice ${action}`);
		if (value === action) actions.push(action as Action);
	}
	return actions;
}

function fieldQuestion(slot: number, action: Action, name: string, spec: FieldSpec, state: MessageState): Question {
	let criteria: Record<string, string>;
	if (spec.mode === "choice") criteria = Object.fromEntries(spec.options!.map((value) => [value, value]));
	else if (name === "target") criteria = Object.fromEntries(Object.entries(state.targets).map(([key]) =>
		[key, `Target from \`targets.${key}\``]));
	else criteria = Object.fromEntries(Object.keys(state.evidence).map((key) => [key, `Source text in \`evidence.${key}\``]));
	return {
		type: "choice",
		instructions: `For selected action ${slot + 1} (${action}) in selectedActions, assess field ${name}: ${spec.description}
Consider only what this human requests for THIS action; use quotedContext to identify its target. Do not borrow unrelated values from another requested action or quoted work. Choose not_provided if this optional field was not specified or is irrelevant to this action. Choose unclear only if it IS requested but ambiguous. Evidence answers select source passages, not finished generated fields.`,
		criteria: { ...criteria, not_provided: "Not supplied/requested, irrelevant, or should remain unchanged.", unclear: "Requested but ambiguous; cannot identify a supported value." },
	};
}

export function detailQuestions(actions: Action[], state: MessageState): Questions {
	const questions: Questions = {};
	for (const [slot, action] of actions.entries()) {
		for (const [name, spec] of Object.entries(fieldsFor(action))) {
			if (spec.mode !== "choice" && spec.mode !== "evidence") continue;
			questions[`s${slot}_${name}`] = fieldQuestion(slot, action, name, spec, state);
		}
	}
	return questions;
}

const choiceAnswer = z.object({ type: z.literal("choice"), choice: z.string(),
	confidence: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)) });

export function validateJevAnswers(raw: unknown, questions: Questions): Answers {
	const parsed = z.object({ answers: z.record(z.string(), choiceAnswer) }).parse(raw);
	for (const [key, question] of Object.entries(questions)) {
		const answer = parsed.answers[key];
		if (!answer || !Object.hasOwn(question.criteria, answer.choice)) throw new Error(`Invalid answer ${key}`);
		if (Object.keys(answer.probabilities).sort().join("|") !== Object.keys(question.criteria).sort().join("|")) {
			throw new Error(`Incomplete probability distribution ${key}`);
		}
		if (Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.02) {
			throw new Error(`Invalid probability sum ${key}`);
		}
	}
	return parsed.answers;
}

export function validateCurrentAnswers(raw: unknown, questions: Questions): Answers {
	const parsed = z.record(z.string(), z.string()).parse(raw);
	const result: Answers = {};
	for (const [key, question] of Object.entries(questions)) {
		const value = parsed[key];
		if (!value || !Object.hasOwn(question.criteria, value)) throw new Error(`Invalid answer ${key}`);
		result[key] = { choice: value };
	}
	return result;
}

export function assemble(actions: Action[], route: Answers, details: Answers, state: MessageState): ActionProposal[] {
	return actions.map((action, slot) => {
		const fields: Record<string, FieldAssessment> = {};
		for (const [name, spec] of Object.entries(fieldsFor(action))) {
			if (spec.mode !== "choice" && spec.mode !== "evidence") {
				fields[name] = { mode: spec.mode, status: spec.mode, note: spec.description };
				continue;
			}
			const value = details[`s${slot}_${name}`]?.choice;
			if (!value) throw new Error(`Missing detail s${slot}_${name}`);
			if (value === "not_provided" || value === "unclear") {
				fields[name] = { mode: spec.mode, status: value, note: spec.description };
			} else {
				fields[name] = { mode: spec.mode, status: "selected", note: spec.description,
					value: spec.mode === "choice" ? value : name === "target" ? state.targets[value] : state.evidence[value],
					probability: details[`s${slot}_${name}`]?.probabilities?.[value],
					...(spec.mode === "evidence" ? { evidenceKey: value } : {}),
				};
			}
		}
		const answer = route[`include_${action}`];
		return { action, fields, probability: answer?.probabilities?.[action] };
	});
}

export function clarificationReasons(actions: ActionProposal[], route: Answers, minProbability: number): string[] {
	const reasons: string[] = [];
	if (route.readiness?.choice === "clarify") reasons.push("essential_context_missing");
	for (const [slot, proposal] of actions.entries()) {
		if (proposal.action === "request_clarification") reasons.push(`slot_${slot}:clarification_selected`);
		if (proposal.probability !== undefined && proposal.probability < minProbability) reasons.push(`slot_${slot}:low_action_probability`);
		if (proposal.fields.target && proposal.fields.target.status !== "selected") reasons.push(`slot_${slot}:unresolved_target`);
		if (proposal.fields.target?.probability !== undefined && proposal.fields.target.probability < minProbability) {
			reasons.push(`slot_${slot}:low_target_probability`);
		}
	}
	// Missing optional fields never trigger a follow-up. This is a tunable offline proposal policy.
	return reasons;
}
