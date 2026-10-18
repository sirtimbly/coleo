import { scoreDecision } from "./classifiers";
import type { Decision } from "./classifiers";
import type { Scenario } from "./fixtures";

export interface Attempt {
	caseId: string;
	kind: Scenario["kind"];
	repeat: number;
	backend: "current" | "jev";
	mode: "model" | "fallback" | "error";
	elapsedMs: number;
	decision?: Decision;
	error?: string;
	logs: string[];
	response?: unknown;
	status?: number;
	servedModel?: string;
	usage?: unknown;
}

function percentile(values: number[], fraction: number): string {
	if (!values.length) return "n/a";
	const sorted = [...values].sort((a, b) => a - b);
	return `${Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!)} ms`;
}

export function renderReport(scenarios: readonly Scenario[], attempts: Attempt[]): string {
	const byId = new Map(scenarios.map((s) => [s.id, s]));
	const lines = [
		"# Brain classification bake-off", "",
		"Synthetic challenge set, labeled before inference. Expected labels follow the current production prompts; labels are provisional, not human-adjudicated ground truth. No live messages or side effects. Repeats are not independent examples.", "",
		"The current backend executes the unmodified ArmOutputProcessor and MailProcessor, including generated fields and fallback behavior. JEV uses the same rendered policy and message, with typed classification and auxiliary questions. Latency compares these actual workloads, not equal-output models. No prompt tuning or confidence threshold selection is performed by the runner.", "",
		"| Channel | Backend | Labels correct | Exact scored fields | Fallbacks | Errors | Model p50 | Model p95 |",
		"|---|---|---:|---:|---:|---:|---:|---:|",
	];
	for (const kind of ["arm", "human"] as const) {
		for (const backend of ["current", "jev"] as const) {
			const rows = attempts.filter((a) => a.kind === kind && a.backend === backend);
			const scores = rows.map((a) => scoreDecision(byId.get(a.caseId)!, a.decision));
			const times = rows.filter((a) => a.mode === "model").map((a) => a.elapsedMs);
			lines.push(`| ${kind} | ${backend} | ${scores.filter((s) => s.primary).length}/${rows.length} | ${scores.filter((s) => s.exact).length}/${rows.length} | ${rows.filter((a) => a.mode === "fallback").length} | ${rows.filter((a) => a.mode === "error").length} | ${percentile(times, .5)} | ${percentile(times, .95)} |`);
		}
	}
	lines.push("", "Exact fields: primary label plus expected no-action follow-up flag, approval polarity, or existing task ID where the fixture specifies one. Generated text quality, task mutation safety, and arbitrary field extraction are outside this test.", "", "## Errors and mismatches", "");
	for (const scenario of scenarios) {
		const rows = attempts.filter((a) => a.caseId === scenario.id);
		if (rows.every((a) => scoreDecision(scenario, a.decision).exact && a.mode === "model")) continue;
		lines.push(`### ${scenario.id}`, "", `Input: ${JSON.stringify({ subject: scenario.subject, text: scenario.text })}`, "",
			`Expected: ${scenario.expected}; ${scenario.rationale}`, "");
		for (const a of rows) lines.push(`- ${a.backend} run ${a.repeat} (${a.mode}): ${a.error || JSON.stringify(a.decision)}`);
		lines.push("");
	}
	lines.push("## Confusion counts", "");
	for (const backend of ["current", "jev"] as const) {
		const counts: Record<string, number> = {};
		for (const row of attempts.filter((a) => a.backend === backend)) {
			const key = `${row.kind}: ${byId.get(row.caseId)!.expected} -> ${row.decision?.label || "ERROR"}`;
			counts[key] = (counts[key] || 0) + 1;
		}
		lines.push(`### ${backend}`, "", "```json", JSON.stringify(counts, null, 2), "```", "");
	}
	lines.push("## Repeat stability", "");
	for (const backend of ["current", "jev"] as const) {
		const repeated = scenarios.filter((s) => attempts.filter((a) => a.caseId === s.id && a.backend === backend).length > 1);
		const unstable = repeated.filter((s) => new Set(attempts.filter((a) => a.caseId === s.id && a.backend === backend)
			.map((a) => JSON.stringify({ label: a.decision?.label, followup: a.decision?.followup, approved: a.decision?.approved, taskId: a.decision?.taskId, mode: a.mode }))).size > 1);
		lines.push(`- ${backend}: ${unstable.length}/${repeated.length} repeated cases changed scored output or mode${unstable.length ? ` (${unstable.map((s) => s.id).join(", ")})` : ""}.`);
	}
	return lines.join("\n") + "\n";
}
