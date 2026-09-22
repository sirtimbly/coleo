import { describe, expect, it } from "bun:test";
import { buildJevRequest, parseJevResponse, scoreDecision } from "../classification-bakeoff/classifiers";
import { SCENARIOS } from "../classification-bakeoff/fixtures";
import { renderReport } from "../classification-bakeoff/report";
import type { JevRequest } from "../classification-bakeoff/classifiers";
import type { Attempt } from "../classification-bakeoff/report";

function responseFor(request: JevRequest, selections: Record<string, string> = {}): unknown {
	return { model: "test-model", answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
		const selected = selections[key] || Object.keys(question.criteria)[0]!;
		return [key, { type: "choice", choice: selected, confidence: 1,
			probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === selected ? 1 : 0])),
		}];
	})) };
}

describe("classification bake-off", () => {
	it("never sends labels, rationales, or fixture IDs to the classifier", () => {
		const scenario = { ...SCENARIOS[0]!, id: "DO_NOT_SEND_ID", rationale: "DO_NOT_SEND_RATIONALE" };
		const request = buildJevRequest(scenario, "current policy", "test-model");
		const alternateLabel = buildJevRequest({ ...scenario, expected: "log_bug", followup: true }, "current policy", "test-model");
		expect(request).toEqual(alternateLabel);
		expect(JSON.stringify(request)).not.toContain("DO_NOT_SEND");
		expect(request.questions.classification!.instructions).toContain("current policy");
	});

	it("scores no_action follow-up independently of the primary label", () => {
		const scenario = SCENARIOS.find((s) => s.id === "arm-waiting-input")!;
		expect(scoreDecision(scenario, { label: "no_action", followup: false })).toEqual({ primary: true, exact: false });
		expect(scoreDecision(scenario, { label: "no_action", followup: true })).toEqual({ primary: true, exact: true });
	});

	it("does not treat uncertain approval as rejection or approval", () => {
		const scenario = SCENARIOS.find((s) => s.id === "human-reject")!;
		const request = buildJevRequest(scenario, "policy", "test-model");
		const result = parseJevResponse(responseFor(request, { classification: "approval_response", approval: "unspecified" }), request);
		expect(result.approved).toBeUndefined();
		expect(scoreDecision(scenario, result).exact).toBe(false);
	});

	it("compares the actual task target rather than just update_task", () => {
		const scenario = SCENARIOS.find((s) => s.id === "arm-update-blocked")!;
		const request = buildJevRequest(scenario, "policy", "test-model");
		const result = parseJevResponse(responseFor(request, { classification: "update_task", task: "task-101" }), request);
		expect(scoreDecision(scenario, result)).toEqual({ primary: true, exact: false });
	});

	it("rejects incomplete or invalid typed responses instead of manufacturing no_action", () => {
		const request = buildJevRequest(SCENARIOS[0]!, "policy", "test-model");
		expect(() => parseJevResponse({ model: "test", answers: {} }, request)).toThrow();
		expect(() => parseJevResponse(responseFor(request, { classification: "invented" }), request)).toThrow();
		expect(scoreDecision(SCENARIOS[0]!)).toEqual({ primary: false, exact: false });
	});

	it("separates fallback latency from successful model latency", () => {
		const scenario = SCENARIOS[0]!;
		const attempts: Attempt[] = [
			{ caseId: scenario.id, kind: "arm", repeat: 1, backend: "current", mode: "fallback", elapsedMs: 1, logs: [], decision: { label: "no_action", followup: false } },
			{ caseId: scenario.id, kind: "arm", repeat: 2, backend: "current", mode: "model", elapsedMs: 1000, logs: [], decision: { label: "no_action", followup: false } },
		];
		const report = renderReport([scenario], attempts);
		expect(report).toContain("| arm | current | 2/2 | 2/2 | 1 | 0 | 1000 ms | 1000 ms |");
	});
});
