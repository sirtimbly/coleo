import { eventMatchesProject, eventStore } from "../../nats/jetstream";
import { getProjectScope } from "../../project-scope";
import { HttpError } from "../middleware";
import type { EventData } from "../../nats/jetstream";

export function inboxActivityId(event: EventData): string {
	const actor = typeof event.data.actor === "string" ? event.data.actor : event.armId || "system";
	const target = typeof event.data.target === "string" ? event.data.target : event.armId || null;
	return typeof event.data.activityId === "string" ? event.data.activityId
		: event.sequence !== undefined ? `event-${event.sequence}` : `${event.type}-${event.timestamp}-${target || actor}`;
}

function matchesItem(event: EventData, itemKey: string): boolean {
	if (!eventMatchesProject(event, getProjectScope().projectKey)) return false;
	if (itemKey.startsWith("activity:")) return itemKey === `activity:${inboxActivityId(event)}`;
	const prefix = `event:${event.type}:${event.timestamp}:`;
	return itemKey.startsWith(prefix) && (event.armId ? itemKey === prefix + event.armId : /^\d+$/.test(itemKey.slice(prefix.length)));
}

export async function getInboxEventRecord(itemKey: string, rawSequence?: string): Promise<EventData> {
	if (!itemKey.startsWith("activity:") && !itemKey.startsWith("event:")) {
		throw HttpError.badRequest("Unsupported event identity");
	}
	if (!eventStore.isInitialized()) throw new HttpError(503, "Event store not available");
	const sequenceText = rawSequence ?? /^activity:event-(\d+)$/.exec(itemKey)?.[1];
	if (sequenceText !== undefined) {
		const sequence = Number(sequenceText);
		if (!Number.isSafeInteger(sequence) || sequence <= 0) throw HttpError.badRequest("Invalid event sequence");
		const event = await eventStore.getEvent(sequence);
		if (!event || !matchesItem(event, itemKey)) throw HttpError.notFound("Inbox event not found");
		return event;
	}
	// Compatibility for saved routes created before stream sequence identities.
	// Only the event source is searched; new links always perform a point read.
	let beforeSequence: number | undefined;
	while (true) {
		const events = await eventStore.queryEvents({ limit: 5000, latest: true, beforeSequence });
		const match = events.find((event) => matchesItem(event, itemKey));
		if (match) return match;
		const oldest = events[0]?.sequence;
		if (events.length < 5000 || oldest === undefined || (beforeSequence !== undefined && oldest >= beforeSequence)) break;
		beforeSequence = oldest;
	}
	throw HttpError.notFound("Inbox event not found or expired");
}
