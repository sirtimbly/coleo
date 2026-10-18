import { createHash } from "node:crypto";
import { join } from "node:path";

import { Maildir } from "../mail/maildir";
import { buildMailThreadDefinitions } from "../workbench/mail-thread-model";

import type { MessagingMailbox } from "../workbench/messaging-query";
import type { MailThreadMessageInput, MailThreadProjection } from "../workbench/mail-thread-model";
import type { MailThreadDetail } from "../workbench/mail-thread-detail";
import { HttpError } from "./middleware/error";

/** Read selected-thread context from the existing inbox, sent, and inbox/archive stores. No loopback HTTP. */
async function readMailInputsOnce(coleoDir: string): Promise<MailThreadMessageInput[]> {
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
	return messages;
}

async function readMailInputs(coleoDir: string): Promise<MailThreadMessageInput[]> {
	for (let attempt = 0; ; attempt++) {
		try { return await readMailInputsOnce(coleoDir); }
		catch (error) {
			const moved = error instanceof Error && "code" in error && error.code === "ENOENT";
			if (!moved || attempt >= 2) throw error;
			// A normal mark-read/archive can move a file after directory enumeration. Retry the
			// complete snapshot, not an empty replacement or an indefinitely looping partial read.
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

function projectThreads(messages: readonly MailThreadMessageInput[], mailbox: MessagingMailbox): MailThreadProjection[] {
	return buildMailThreadDefinitions(messages, mailbox).map((thread) => ({
		...thread, revision: createHash("sha256").update(JSON.stringify(thread)).digest("hex"),
	}));
}

export async function loadMailThreadProjections(coleoDir: string, mailbox: MessagingMailbox): Promise<MailThreadProjection[]> {
	return projectThreads(await readMailInputs(coleoDir), mailbox);
}

/** Navigation can resolve any mailbox from one authoritative Maildir read. */
export async function loadMailThreadMailboxProjections(coleoDir: string): Promise<readonly MailThreadProjection[]> {
	const input = await readMailInputs(coleoDir);
	return (["inbox", "sent", "archive"] as const).flatMap((mailbox) => projectThreads(input, mailbox));
}

export function findMailThread(threads: readonly MailThreadProjection[], id: string): MailThreadProjection | undefined {
	const exact = threads.find((thread) => thread.id === id);
	if (exact) return exact;
	const aliases = threads.filter((thread) => thread.aliases?.includes(id));
	if (aliases.length > 1) throw new HttpError(409, "The legacy thread link is ambiguous; select the conversation by its stable ID");
	return aliases[0];
}

export async function loadMailThreadDetail(coleoDir: string, mailbox: MessagingMailbox, id: string): Promise<MailThreadDetail | null> {
	const input = await readMailInputs(coleoDir);
	const thread = findMailThread(projectThreads(input, mailbox), id);
	if (!thread) return null;
	const byLocation = new Map(input.map((message) => [`${message.mailbox}:${message.id}`, message]));
	const messages = thread.hierarchy.nodes.filter((node) => node.selectable).map((node) => {
		const location = node.data.locations.find((entry) => entry.mailbox === mailbox) ?? node.data.locations[0]!;
		const message = byLocation.get(`${location.mailbox}:${location.messageId}`)!;
		return { id: node.id, from: message.from, to: message.headers.to ?? "", subject: message.subject,
			timestamp: message.timestamp, body: message.body };
	});
	return { schemaVersion: 1, thread, messages };
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
