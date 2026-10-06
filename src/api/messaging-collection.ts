import { z } from "zod";

import { eventStore } from "../nats/jetstream";
import { getProjectScope } from "../project-scope";
import { messagingSourcesForQuery, projectMessagingItems } from "../workbench/messaging-collection";
import { compareMessagingPositions, messagingQueryIdentity, normalizeMessagingQuery } from "../workbench/messaging-query";
import { loadMailThreadProjections } from "./mail-thread-projection";
import { messagingEventItem, messagingRecordItem, messagingRevision, messagingThreadItem } from "./messaging-items";
import { HttpError } from "./middleware/error";
import { listWorkbenchInboxPage, mapInboxAttention } from "./workbench-inbox-page";

import type { Database } from "bun:sqlite";
import type { EventData, IEventStore } from "../nats/jetstream-types";
import type { MessagingCollectionPage, MessagingItem, MessagingSourceId, MessagingSourceState } from "../workbench/messaging-collection";
import type { MessagingQuery } from "../workbench/messaging-query";
import type { InboxAttentionRow } from "./workbench-inbox-page";

const cursorSchema = z.object({ schemaVersion: z.literal(1), queryId: z.string(),
	before: z.object({ timestamp: z.iso.datetime(), id: z.string().min(1) }).strict(),
	events: z.object({ firstSequence: z.number().int().nonnegative(), lastSequence: z.number().int().nonnegative() }).strict().nullable(),
}).strict();
type CollectionCursor = z.infer<typeof cursorSchema>;

export interface MessagingCollectionDependencies {
	store?: IEventStore;
	loadMail?: typeof loadMailThreadProjections;
	now?: () => Date;
	sourceTimeoutMs?: number;
}

async function deadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([work, new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Source read timed out; previously loaded data is not authoritative empty")), milliseconds);
	})]); } finally { if (timer) clearTimeout(timer); }
}

export function parseMessagingRequest(value: string): MessagingQuery {
	try { return normalizeMessagingQuery(JSON.parse(value)); }
	catch (error) { throw HttpError.badRequest(`Invalid Messaging query: ${error instanceof Error ? error.message : String(error)}`); }
}

function decodeCursor(value: string | undefined, queryId: string): CollectionCursor | null {
	if (value === undefined) return null;
	try {
		if (!value || value.length > 16000) throw new Error("Invalid cursor length");
		const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
		if (cursor.queryId !== queryId) throw new Error("Cursor belongs to another query");
		return cursor;
	} catch { throw HttpError.badRequest("Invalid Messaging cursor; restart traversal after changing the query"); }
}

/** Capture a retained sequence boundary; scan through sparse windows rather than assuming a short prefix is exhaustive. */
async function retainedSnapshot(store: IEventStore, pinned: CollectionCursor["events"]): Promise<{
	events: EventData[]; boundary: NonNullable<CollectionCursor["events"]>;
}> {
	if (!store.isInitialized()) throw new Error("Retained event store is unavailable");
	const metrics = await store.getStreamMetrics();
	if (pinned && (pinned.firstSequence > pinned.lastSequence || pinned.lastSequence > metrics.lastSequence)) {
		throw new Error("Invalid retained traversal boundary; refresh the query");
	}
	if (pinned && metrics.firstSequence > pinned.firstSequence && pinned.firstSequence > 0) {
		throw new Error("Retained traversal expired; refresh the query to establish a new boundary");
	}
	const boundary = pinned ?? { firstSequence: metrics.firstSequence, lastSequence: metrics.lastSequence };
	const events = new Map<number, EventData>();
	let before = boundary.lastSequence + 1;
	const projectKey = getProjectScope().projectKey;
	while (before > boundary.firstSequence && boundary.lastSequence > 0) {
		const batch = await store.queryEvents({ limit: 5000, latest: true, beforeSequence: before, strict: true });
		for (const event of batch) {
			if (event.sequence === undefined) throw new Error("Retained event has no stable sequence");
			if (event.sequence > boundary.lastSequence || event.sequence < boundary.firstSequence) continue;
			if (event.projectKey !== undefined && event.projectKey !== projectKey) continue;
			events.set(event.sequence, event);
		}
		const oldest = batch.reduce((min, event) => Math.min(min, event.sequence ?? min), before);
		const next = oldest < before ? oldest : Math.max(boundary.firstSequence, before - 5000);
		if (next >= before) throw new Error("Retained continuation did not advance");
		before = next;
	}
	const current = await store.getStreamMetrics();
	if (current.firstSequence > boundary.firstSequence && boundary.firstSequence > 0) {
		throw new Error("Retention changed during traversal; refresh the query");
	}
	return { events: [...events.values()], boundary };
}

function recordsSnapshot(db: Database, profileId: string): MessagingItem[] {
	return db.transaction(() => {
		const items: MessagingItem[] = [];
		let cursor: string | undefined;
		do {
			const page = listWorkbenchInboxPage(db, profileId, "200", cursor);
			items.push(...page.items.map(messagingRecordItem));
			cursor = page.nextCursor;
		} while (cursor);
		const reports = db.query("SELECT id, arm_id AS armId, task_id AS taskId, status FROM status_reports").all() as
			Array<{ id: string; armId: string; taskId: string; status: string }>;
		const byId = new Map(reports.map((report) => [`status:${report.id}`, report]));
		return items.map((item) => {
			const report = byId.get(item.id);
			return report ? { ...item, actor: { kind: "arm" as const, id: report.armId, displayName: report.armId },
				facts: [{ label: "Arm", value: report.armId }, { label: "Task", value: report.taskId },
					{ label: "Status", value: report.status.replaceAll("_", " ") }],
				severity: report.status === "on_track" ? "success" as const : item.severity } : item;
		});
	})();
}

export async function loadMessagingCollection(
	db: Database, coleoDir: string, query: MessagingQuery, cursorValue?: string, dependencies: MessagingCollectionDependencies = {},
): Promise<MessagingCollectionPage> {
	const queryId = messagingQueryIdentity(query);
	const cursor = decodeCursor(cursorValue, queryId);
	if (!db.query("SELECT id FROM workbench_profiles WHERE id = ?").get(query.profileId)) {
		throw HttpError.notFound(`Workbench profile not found: ${query.profileId}`);
	}
	const asOf = (dependencies.now?.() ?? new Date()).toISOString();
	const requested = messagingSourcesForQuery(query);
	const sqlite = db.transaction(() => {
		let records: MessagingItem[] = [];
		let error: Error | null = null;
		if (requested.includes("records")) {
			try { records = recordsSnapshot(db, query.profileId); }
			catch (reason) { error = reason instanceof Error ? reason : new Error(String(reason)); }
		}
		const attention = db.query(`SELECT profile_id AS profileId, item_key AS itemKey, seen_at AS seenAt, read_at AS readAt,
			archived_at AS archivedAt, snoozed_until AS snoozedUntil, resolved_at AS resolvedAt, assigned_to AS assignedTo,
			requires_action AS requiresAction, updated_at AS updatedAt FROM workbench_attention WHERE profile_id = ?`)
			.all(query.profileId) as InboxAttentionRow[];
		return { records, error, attention };
	})();
	const needsEvents = requested.includes("activity") || requested.includes("events");
	const timeout = dependencies.sourceTimeoutMs ?? 12000;
	const retained = needsEvents ? deadline(retainedSnapshot(dependencies.store ?? eventStore, cursor?.events ?? null), timeout) : null;
	let boundary = cursor?.events ?? null;
	const sourceResults = await Promise.all(requested.map(async (id): Promise<{ items: MessagingItem[]; state: MessagingSourceState }> => {
		try {
			let items: MessagingItem[];
			let revision: string;
			if (id === "records") { if (sqlite.error) throw sqlite.error; items = sqlite.records; revision = messagingRevision(items); }
			else if (id === "mail") {
				items = (await deadline((dependencies.loadMail ?? loadMailThreadProjections)(coleoDir, query.mailbox), timeout)).map(messagingThreadItem);
				revision = messagingRevision(items);
			} else {
				const snapshot = await retained!;
				boundary = snapshot.boundary;
				items = snapshot.events.map(messagingEventItem).filter((item) => item.sourceId === id);
				revision = `${snapshot.boundary.firstSequence}:${snapshot.boundary.lastSequence}`;
			}
			return { items, state: { id, status: "fresh", revision, asOf, complete: true } };
		} catch (error) {
			return { items: [], state: { id, status: "unavailable", revision: null, asOf: null, complete: false,
				error: { code: "SOURCE_UNAVAILABLE", message: error instanceof Error ? error.message : `Source ${id} is unavailable` } } };
		}
	}));
	// Attention is part of every source's authoritative projection, not a ninth independent browser merge.
	const attention = new Map(sqlite.attention.map((row) => [row.itemKey, mapInboxAttention(row)]));
	const deduplicated = new Map(sourceResults.flatMap((source) => source.items).map((item) => [item.id, item]));
	const stateful = [...deduplicated.values()].flatMap((item) => {
		const state = attention.get(item.id);
		if (state?.archivedAt || state?.snoozedUntil && state.snoozedUntil > asOf) return [];
		if (!state) return [item];
		const result = { ...item, unread: state.readAt ? false : item.unread,
			requiresAction: state.resolvedAt ? false : state.requiresAction || item.requiresAction };
		return [{ ...result, revision: messagingRevision({ item: result, attention: state }) }];
	});
	const projected = projectMessagingItems(stateful, query);
	const traversal = cursor ? projected.filter((item) => compareMessagingPositions(item, cursor.before, query.sort.direction) > 0) : projected;
	const items = traversal.slice(0, query.limit);
	const sources = sourceResults.map((source) => source.state);
	const complete = sources.every((source) => source.complete);
	const last = items.at(-1);
	const nextCursor = complete && traversal.length > query.limit && last ? Buffer.from(JSON.stringify({
		schemaVersion: 1, queryId, before: { timestamp: last.timestamp, id: last.id }, events: boundary,
	} satisfies CollectionCursor)).toString("base64url") : null;
	return { schemaVersion: 1, query, queryId, cursor: cursorValue ?? null, nextCursor, items, sources,
		summaries: { scope: "query", total: projected.length, unread: projected.filter((item) => item.unread).length,
			requiresAction: projected.filter((item) => item.requiresAction).length, complete } };
}
