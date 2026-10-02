import { createHash } from "node:crypto";
import { join } from "node:path";

import { Maildir } from "../mail/maildir";
import { buildMailThreadDefinitions } from "../workbench/mail-thread-model";

import type { MessagingMailbox } from "../workbench/messaging-query";
import type { MailThreadMessageInput, MailThreadProjection } from "../workbench/mail-thread-model";

/** Read selected-thread context from the existing inbox, sent, and inbox/archive stores. No loopback HTTP. */
export async function loadMailThreadProjections(coleoDir: string, mailbox: MessagingMailbox): Promise<MailThreadProjection[]> {
	const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
	const sent = new Maildir(join(coleoDir, "mail", "sent"));
	const snapshots = await Promise.all([
		inbox.list("new", { strict: true }), inbox.list("cur", { strict: true }),
		sent.list("new", { strict: true }), sent.list("cur", { strict: true }), inbox.list("archive", { strict: true }),
	]);
	const messages: MailThreadMessageInput[] = snapshots.flatMap((batch, index) => batch.map((message) => ({
		id: message.id, mailbox: index < 2 ? "inbox" as const : index < 4 ? "sent" as const : "archive" as const,
		from: message.from, subject: message.subject, timestamp: message.date.toISOString(),
		body: message.body, seen: message.flags.seen, headers: message.headers,
	})));
	return buildMailThreadDefinitions(messages, mailbox).map((thread) => ({
		...thread, revision: createHash("sha256").update(JSON.stringify(thread)).digest("hex"),
	}));
}

export async function readThreadMessage(
	coleoDir: string, thread: MailThreadProjection, messageId: string,
): Promise<{ id: string; from: string; subject: string; timestamp: string; body: string } | null> {
	const node = thread.hierarchy.nodes.find((candidate) => candidate.data.messageId === messageId && candidate.selectable);
	if (!node) return null;
	const location = node.data.locations.find((candidate) => candidate.mailbox === thread.mailbox) ?? node.data.locations[0];
	if (!location) return null;
	const store = new Maildir(join(coleoDir, "mail", location.mailbox === "sent" ? "sent" : "inbox"));
	const messages = location.mailbox === "archive" ? await store.list("archive", { strict: true })
		: [...await store.list("new", { strict: true }), ...await store.list("cur", { strict: true })];
	const message = messages.find((candidate) => candidate.id === location.messageId);
	return message ? { id: node.id, from: message.from, subject: message.subject,
		timestamp: message.date.toISOString(), body: message.body } : null;
}
