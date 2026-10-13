import { resourceReference } from "../workbench/resource-reference";
import { eventStore } from "../nats/jetstream";
import { loadMailThreadMailboxProjections } from "./mail-thread-projection";
import { retainedMessagingSnapshot } from "./messaging-collection";
import { messagingEventItem } from "./messaging-items";
import { HttpError } from "./middleware/error";

import type { Database } from "bun:sqlite";
import type { MessagingItem } from "../workbench/messaging-collection";
import type { IEventStore } from "../nats/jetstream-types";
import type { MessagingReferenceTarget } from "../workbench/resource-reference";

export interface MessagingReferenceDependencies {
	readonly store?: IEventStore;
	readonly loadMail?: typeof loadMailThreadMailboxProjections;
	readonly timeoutMs?: number;
}

async function bounded<T>(work: Promise<T>, timeout: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Reference source timed out")), timeout); })]); }
	finally { clearTimeout(timer); }
}

/** Detail navigation is independent of list eligibility, attention, sort, and page position. */
export async function resolveMessagingReference(
	db: Database, coleoDir: string, reference: string, profileId = "local", dependencies: MessagingReferenceDependencies = {},
): Promise<MessagingReferenceTarget> {
	if (!/^@[a-f0-9]{8}$/.test(reference) && !/^(thread|message|task|bug|status|swarm|brain|activity|event):.+/.test(reference)) throw HttpError.badRequest("Use a displayed @reference or a full resource ID");
	if (reference.length > 1024) throw HttpError.badRequest("Resource identity is too long");
	if (!db.query("SELECT id FROM workbench_profiles WHERE id = ?").get(profileId)) throw HttpError.notFound(`Workbench profile not found: ${profileId}`);
	const matches = new Map<string, MessagingItem["detail"]>();
	const match = (id: string, detail: MessagingItem["detail"]) => {
		if ((id === reference || resourceReference(id) === reference) && !matches.has(id)) matches.set(id, detail);
	};
	const records = db.query(`SELECT 'task:' || id AS id FROM tasks UNION ALL SELECT 'bug:' || id FROM bugs
		UNION ALL SELECT 'status:' || id FROM status_reports UNION ALL SELECT 'swarm:' || id FROM brain_swarm_recommendations
		UNION ALL SELECT 'brain:planning-gate' FROM infrastructure_health WHERE component = 'brain_planning_gate'`).all() as { id: string }[];
	for (const { id } of records) match(id, { kind: "record", itemKey: id });
	const diagnostics: string[] = [];
	const timeout = dependencies.timeoutMs ?? 12_000;
	await Promise.all([
		(async () => {
			try {
				const threads = await bounded((dependencies.loadMail ?? loadMailThreadMailboxProjections)(coleoDir), timeout);
				for (const thread of threads) {
					match(`thread:${thread.mailbox}:${thread.id}`, { kind: "thread", threadId: thread.id, mailbox: thread.mailbox });
					for (const node of thread.hierarchy.nodes) if (node.selectable && node.data.messageId) match(node.id,
						{ kind: "message", threadId: thread.id, messageId: node.data.messageId, mailbox: thread.mailbox });
				}
			} catch { diagnostics.push("Mail reference source is unavailable"); }
		})(),
		(async () => {
			try {
				const snapshot = await bounded(retainedMessagingSnapshot(dependencies.store ?? eventStore, null), timeout);
				for (const event of snapshot.events) { const item = messagingEventItem(event); if (item) match(item.id, item.detail); }
			} catch { diagnostics.push("Retained event reference source is unavailable"); }
		})(),
	]);
	if (matches.size > 1) throw new HttpError(409, "Compact reference is ambiguous; use a full ID from --json");
	const target = [...matches][0];
	if (!target) {
		if (diagnostics.length) throw new HttpError(503, "Reference lookup is incomplete because a source is unavailable; retry when the source recovers");
		throw HttpError.notFound("Reference not found in this project; the resource may have been deleted or expired");
	}
	return { schemaVersion: 1, id: target[0], detail: target[1], complete: !diagnostics.length, diagnostics };
}
