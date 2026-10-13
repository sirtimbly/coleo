import boxen from "boxen";
import wrapAnsi from "wrap-ansi";
import { stripVTControlCharacters } from "node:util";
import { inboxReference } from "./references";
import { inboxTerminalColumns } from "./table";
import { terminalText } from "./terminal-text";
import { inboxColorEnabled, inboxInk } from "./terminal-theme";

import type { InboxTextOptions } from "./table";

export interface InboxDetailOutput {
	readonly id: string;
	readonly detail: unknown;
	readonly complete?: boolean;
	readonly diagnostics?: readonly string[];
	readonly query?: { readonly profileId?: string; readonly mailbox?: string; readonly facet?: string };
}

/** Treat non-object detail values as empty records while formatting heterogeneous API payloads. */
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Preserve paragraphs, blank lines and indentation, but never transport terminal controls. */
function bodyText(value: unknown, width: number): string {
	const text = stripVTControlCharacters(String(value ?? "")).replace(/\r\n?/g, "\n");
	return text.split("\n").map((line) => wrapAnsi(terminalText(line.replace(/\t/g, "    ")), width,
		{ hard: true, trim: false })).join("\n");
}

/** Pure one-shot output. Accepts the command's detail envelope; JSON serialization stays with its caller. */
export function formatInboxDetail(output: InboxDetailOutput, options: InboxTextOptions = {}): string {
	const supplied = options.columns ?? inboxTerminalColumns();
	const width = Math.max(18, Math.floor(Number.isFinite(supplied) ? supplied : 80) - 2);
	const inner = width - 4;
	const ink = inboxInk(options.color ?? inboxColorEnabled());
	const wrap = (value: string) => wrapAnsi(terminalText(value), width, { hard: true });
	const detail = record(output.detail);
	const thread = record(detail.thread);
	const lines = [ink.reference(wrap(`Inbox · ${inboxReference(output.id)}`))];
	if (output.query) lines.push(wrap([output.query.facet, output.query.mailbox,
		output.query.profileId ? `Profile: ${output.query.profileId}` : ""].filter(Boolean).join(" · ")));
	if (thread.title || thread.subject) lines.push(wrap(`Thread: ${terminalText(thread.title ?? thread.subject)}`));
	if (output.complete === false) lines.push(wrap("INCOMPLETE SOURCES — detail may be partial."));
	for (const diagnostic of output.diagnostics ?? []) lines.push(wrap(`Notice: ${diagnostic}`));
	const messages = Array.isArray(detail.messages) ? detail.messages : detail.message ? [detail.message] : [];
	const nodes = record(thread.hierarchy).nodes;
	const parents = new Map(Array.isArray(nodes) ? nodes.map((node: unknown) => {
		const item = record(node);
		return [item.id, item.parentId] as const;
	}) : []);
	for (const value of messages) {
		const message = record(value);
		const heading = bodyText(message.subject ?? "Message", inner);
		const headers: string[] = [];
		if (typeof message.id === "string") headers.push(`Ref: ${inboxReference(message.id)}`);
		const parent = parents.get(message.id);
		if (typeof parent === "string") headers.push(`Reply to: ${inboxReference(parent)}`);
		for (const [key, label] of [["from", "From"], ["to", "To"], ["timestamp", "When"]] as const) {
			if (message[key] !== undefined) headers.push(`${label}: ${terminalText(message[key])}`);
		}
		lines.push("", boxen([ink.title(heading), ...headers.map((line) => bodyText(line, inner)), "",
			bodyText(message.body, inner)].join("\n"), { width, borderStyle: "single", padding: { left: 1, right: 1, top: 0, bottom: 0 } }));
	}
	if (!messages.length) {
		// Event, status and record payloads have different schemas. Preserve all fields as readable labeled sections.
		const describe = (value: unknown, path = ""): void => {
			if (value !== null && typeof value === "object") {
				for (const [key, child] of Object.entries(value)) describe(child, path ? `${path} / ${key}` : key);
			} else lines.push("", ink.muted(wrap(path || "Detail")), bodyText(value, width));
		};
		describe(output.detail);
	}
	return lines.join("\n");
}
