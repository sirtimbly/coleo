import type { JsonObject } from "@/lib";

export type ViewerActivityType =
	| "message"
	| "tool"
	| "file"
	| "session"
	| "error"
	| "todo"
	| "step"
	| "terminal"
	| "branch";

export interface ViewerActivityItem {
	id: string;
	type: ViewerActivityType;
	title: string;
	subtitle?: string;
	status: "pending" | "running" | "completed" | "error" | "info";
	timestamp: number;
	details?: JsonObject;
	expanded?: boolean;
}

interface EventIdentity {
	type: string;
	timestamp?: string;
	sequence?: number;
	properties: JsonObject;
}

function hashString(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

export function getViewerEventActivityId(event: EventIdentity, suffix: string): string {
	if (typeof event.sequence === "number") {
		return `event-${event.sequence}-${suffix}`;
	}

	const fingerprint = hashString(JSON.stringify(event.properties));
	return `event-${event.type}-${event.timestamp ?? "unknown"}-${fingerprint}-${suffix}`;
}

export function isViewerHeartbeatActivity(activity: ViewerActivityItem): boolean {
	const eventType = activity.details?.eventType;
	return activity.title.toLowerCase().includes("heartbeat") ||
		(typeof eventType === "string" && eventType.toLowerCase().includes("heartbeat"));
}

export function upsertViewerActivity(
	activities: ViewerActivityItem[],
	activity: ViewerActivityItem,
	limit: number,
): ViewerActivityItem[] {
	const index = activities.findIndex((candidate) => candidate.id === activity.id);
	let next: ViewerActivityItem[];

	if (index >= 0) {
		const existing = activities[index]!;
		if (activity.timestamp < existing.timestamp) {
			return activities;
		}
		next = [...activities];
		next[index] = { ...existing, ...activity };
	} else {
		next = [...activities, activity];
	}

	next.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
	return next.length > limit ? next.slice(-limit) : next;
}
