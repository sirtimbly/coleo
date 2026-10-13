import { clarificationReasons } from "./queries";
import type { ActionProposal, Answers } from "./queries";
import type { HistoricalMessage, HumanLabel } from "./history";

export interface Result {
	messageId: string;
	backend: "legacy" | "expanded-current" | "jev";
	status: "ok" | "fallback" | "error";
	elapsedMs: number;
	routingMs: number;
	detailsMs: number;
	actions: ActionProposal[];
	route: Answers;
	followupReasons: string[];
	stages: Array<{ name: string; model?: string; usage?: unknown; response?: unknown; status?: number }>;
	error?: string;
}

export function score(result: Result, label: HumanLabel): { actions: boolean; fields: boolean } {
	const actions = result.status === "ok" && JSON.stringify(result.actions.map((a) => a.action)) === JSON.stringify(label.actions);
	const fields = actions && Object.entries(label.fields || {}).every(([slot, expected]) =>
		Object.entries(expected).every(([name, value]) => result.actions[Number(slot)]?.fields[name]?.value === value));
	return { actions, fields };
}

function p(values: number[], fraction: number): string {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? `${Math.round(sorted[Math.ceil(sorted.length * fraction) - 1]!)} ms` : "n/a";
}

export function report(messages: HistoricalMessage[], labels: Record<string, HumanLabel>, results: Result[]): string {
	const labeled = messages.filter((m) => labels[m.id]);
	const lines = ["# Historical human-to-brain evaluation", "",
		`${messages.length} recovered direct messages; ${labeled.length} user-labeled development examples. Unlabeled messages are NOT included in accuracy. No held-out accuracy claim is possible until more labels are collected.`, "",
		"Legacy runs the unchanged MailProcessor with its original action set. Expanded-current and JEV share the expanded policy, choice questions, source evidence, and two-stage route/detail contract. This distinguishes a better action vocabulary from a better model. Neither pipeline executes actions.", "",
		"| Backend | Successful / attempted | Development actions | Development labeled fields + actions | Proposed follow-ups | Route p50 | End-to-end p50 | End-to-end p95 |",
		"|---|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const backend of ["legacy", "expanded-current", "jev"] as const) {
		const rows = results.filter((r) => r.backend === backend);
		const ok = rows.filter((r) => r.status === "ok");
		const scored = rows.filter((r) => labels[r.messageId]).map((r) => score(r, labels[r.messageId]!));
		lines.push(`| ${backend} | ${ok.length}/${rows.length} | ${scored.filter((s) => s.actions).length}/${scored.length} | ${scored.filter((s) => s.fields).length}/${scored.length} | ${ok.filter((r) => r.followupReasons.length).length}/${ok.length} | ${p(ok.map((r) => r.routingMs), .5)} | ${p(ok.map((r) => r.elapsedMs), .5)} | ${p(ok.map((r) => r.elapsedMs), .95)} |`);
	}
	const pairs = messages.flatMap((message) => {
		const current = results.find((r) => r.messageId === message.id && r.backend === "expanded-current" && r.status === "ok");
		const jev = results.find((r) => r.messageId === message.id && r.backend === "jev" && r.status === "ok");
		return current && jev ? [{ current, jev }] : [];
	});
	const matched = pairs.filter(({ current, jev }) =>
		JSON.stringify(current.actions.map((a) => a.action)) === JSON.stringify(jev.actions.map((a) => a.action)));
	lines.push("", `Expanded-current and JEV selected identical action sets on ${matched.length}/${pairs.length} pairs with valid outputs. On those matching pairs, end-to-end p50 was ${p(matched.map(({ current }) => current.elapsedMs), .5)} for expanded-current and ${p(matched.map(({ jev }) => jev.elapsedMs), .5)} for JEV. Agreement is not accuracy.`, "");
	for (const backend of ["expanded-current", "jev"] as const) {
		const rows = results.filter((r) => r.backend === backend && r.status === "ok");
		lines.push(`${backend}: ${rows.filter((r) => !r.actions.length).length}/${rows.length} no-action decisions; ${rows.filter((r) => r.stages.length === 2).length} two-stage evaluations. No-action decisions skip detail extraction, which affects aggregate latency.`);
	}
	lines.push("", "Follow-up rates are proposed requests for clarification, not user-rated annoyance. Missing optional fields do not cause follow-ups. Model confidence is not treated as calibrated accuracy. Text/object/array/numeric/date fields use evidence anchors; these are NOT complete generated API payloads. System fields are explicitly excluded from model invention.", "", "## User-labeled development examples", "");
	for (const message of labeled) {
		lines.push(`### ${message.id}`, "", `Expected: ${JSON.stringify(labels[message.id])}`, "");
		for (const result of results.filter((r) => r.messageId === message.id)) {
			lines.push(`- ${result.backend}: ${result.actions.map((a) => a.action).join(", ") || (result.status === "ok" ? "no_action" : result.status)}; score ${JSON.stringify(score(result, labels[message.id]!))}; follow-up ${JSON.stringify(result.followupReasons)}`);
			for (const [slot, expected] of Object.entries(labels[message.id]!.fields || {})) {
				for (const field of Object.keys(expected)) lines.push(`  - ${field}: ${JSON.stringify(result.actions[Number(slot)]?.fields[field]?.value ?? null)}`);
			}
		}
		lines.push("");
	}
	lines.push("## JEV clarification threshold sweep (descriptive, not tuned)", "",
		`Selected action/target probability thresholds are applied after inference. Only the ${labeled.length} development labels can score errors; the rest measure coverage/follow-up burden, not accuracy. Omitted actions are not protected by this threshold: a missed action can pass without clarification.`, "",
		"| Minimum action/target probability | Follow-up proposals | Development cases without follow-up | Wrong labeled actions/fields without follow-up |", "|---:|---:|---:|---:|");
	const jev = results.filter((r) => r.backend === "jev" && r.status === "ok");
	for (const threshold of [0, .5, .6, .7, .8, .9, .95]) {
		const acted = jev.filter((r) => clarificationReasons(r.actions, r.route, threshold).length === 0);
		const dev = acted.filter((r) => labels[r.messageId]);
		lines.push(`| ${threshold} | ${jev.length - acted.length}/${jev.length} | ${dev.length} | ${dev.filter((r) => !score(r, labels[r.messageId]!).fields).length} |`);
	}
	lines.push("", "## Unlabeled action disagreements for review", "");
	for (const message of messages.filter((m) => !labels[m.id])) {
		const rows = results.filter((r) => r.messageId === message.id);
		if (new Set(rows.map((r) => JSON.stringify(r.actions.map((a) => a.action)))).size < 2 && rows.every((r) => r.status === "ok")) continue;
		lines.push(`### ${message.id}`, "", `Subject: ${message.subject.replace(/\n/g, " ")}`, "");
		for (const row of rows) lines.push(`- ${row.backend}: ${row.status}; ${row.actions.map((a) => a.action).join(", ") || (row.status === "ok" ? "no_action" : "no valid output")}; follow-up ${row.followupReasons.join(", ") || "none"}`);
		lines.push("");
	}
	const errors = results.filter((r) => r.status !== "ok");
	if (errors.length) {
		lines.push("## Errors and fallbacks", "");
		for (const result of errors) lines.push(`- ${result.messageId} / ${result.backend}: ${result.status}; ${JSON.stringify(result.error || "Processor fallback")}`);
		lines.push("");
	}
	return lines.join("\n") + "\n";
}
