import { createHash } from "node:crypto";
import { join } from "node:path";
import { Maildir } from "../../mail/maildir";
import type { Action } from "./schema";
import type { MailMessage } from "../../mail/maildir";

export interface HistoricalMessage {
	id: string;
	messageId: string;
	date: string;
	subject: string;
	body: string;
	headers: Record<string, string>;
	sourcePath: string;
}
export interface HumanLabel {
	actions: Action[];
	fields?: Record<string, Record<string, string>>;
	split: "development" | "holdout";
	provenance: string;
}

// Explicit labels supplied by the user in this conversation. Never sent as examples
// with individual requests. Their general policy implications are in POLICY.
export const HUMAN_LABELS: Record<string, HumanLabel> = {
	"human-0d048f793929": {
		actions: ["new_task", "bug_report"], split: "development",
		provenance: "User chose one feature task plus one bug report.",
	},
	"human-94966268e90e": {
		actions: ["reprioritize_task"], split: "development",
		fields: { "0": { priority: "low", queuePosition: "bottom", target: "refactor-1771210128869-kwfm" } },
		provenance: "User chose low priority and bottom of queue without approval/rejection.",
	},
	"human-6adcdfecaf9a": {
		actions: ["prompt_arm"], fields: { "0": { target: "default" } }, split: "development",
		provenance: "User chose only prompt arm default, not a separate status answer.",
	},
};

export function isDirectHumanMessage(message: MailMessage): boolean {
	const type = (message.headers["x-coleo-type"] || "").toLowerCase();
	return /brain@coleo\.local/i.test(message.to) && !/brain@coleo\.local/i.test(message.from)
		&& (type === "human-message" || (!type && /^human@(?:coleo\.)?local$/i.test(message.from.trim())));
}

export async function loadHistory(mailRoot: string): Promise<HistoricalMessage[]> {
	const messages = (await Promise.all(["inbox", "sent"].flatMap((mailbox) =>
		["new", "cur", "archive"].map((folder) => new Maildir(join(mailRoot, mailbox))
			.list(folder as "new" | "cur" | "archive"))))).flat();
	const unique = new Map<string, HistoricalMessage>();
	for (const message of messages) {
		if (!isDirectHumanMessage(message)) continue;
		if (!Number.isFinite(message.date.getTime())) throw new Error(`Invalid message date: ${message.id}`);
		const messageId = message.headers["message-id"] || message.id;
		const id = `human-${createHash("sha256").update(messageId).digest("hex").slice(0, 12)}`;
		const record = {
			id, messageId, date: message.date.toISOString(), subject: message.subject, body: message.body,
			headers: Object.fromEntries(Object.entries(message.headers).filter(([key]) =>
				["in-reply-to", "references", "x-coleo-thread-id", "x-coleo-task-id", "x-coleo-bug-id",
					"x-coleo-request-id", "x-coleo-priority", "x-coleo-domain", "x-coleo-attachments"].includes(key))),
			sourcePath: message.filePath || "",
		};
		const previous = unique.get(id);
		if (previous && (previous.body !== record.body || previous.subject !== record.subject)) {
			throw new Error(`Conflicting copies of message ${id}; resolve before evaluation`);
		}
		unique.set(id, record);
	}
	return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export interface MessageState {
	date: string;
	subject: string;
	authoredText: string;
	quotedContext: string;
	headers: Record<string, string>;
	evidence: Record<string, string>;
	evidenceTruncated: boolean;
	targets: Record<string, string>;
}

export function buildState(message: HistoricalMessage): MessageState {
	const boundary = message.body.search(/\n---\nIn reply to:/i);
	const authoredText = boundary < 0 ? message.body : message.body.slice(0, boundary).trim();
	const quotedContext = boundary < 0 ? "" : message.body.slice(boundary);
	const evidence: Record<string, string> = { subject: message.subject, authored: authoredText };
	const chunks = [...new Set(authoredText.split(/\n+|(?<=[.!?])\s+|\s+also\s+/i).map((s) => s.trim()).filter(Boolean))];
	for (const [index, chunk] of chunks.slice(0, 40).entries()) evidence[`passage_${index}`] = chunk;
	if (quotedContext) evidence.quoted_context = quotedContext;
	const identifiers = [...new Set((`${message.subject}\n${message.body}\n${JSON.stringify(message.headers)}`)
		.match(/\b(?:task|bug|approval|refactor|phase\d+)-[a-zA-Z0-9][a-zA-Z0-9_-]*/g) || [])];
	const arms = [...message.body.matchAll(/\barm\s+["“]?([a-zA-Z][a-zA-Z0-9_-]*)/gi)]
		.map((match) => match[1]!).filter((name) => !["is", "was", "should", "needs", "can", "agents", "that", "with", "harness", "context", "activity"].includes(name.toLowerCase()));
	const targets = Object.fromEntries([...new Set([...identifiers, ...arms])].slice(0, 100)
		.map((value, index) => [`target_${index}`, value]));
	return { date: message.date, subject: message.subject, authoredText, quotedContext,
		headers: message.headers, evidence, evidenceTruncated: chunks.length > 40, targets };
}
