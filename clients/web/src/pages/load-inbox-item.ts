import { api } from "@/lib/api";
import { projectRecentEvent } from "@/workbench/recent-event-inbox";
import { activityToItem, brainActivityToItem, reportToItem, workbenchInboxToItem } from "./inbox-item-projection";
import type { InboxItemData } from "./inbox-item-projection";

export function inboxItemQueryKey(itemId: string): readonly ["inbox-item", string] {
	return ["inbox-item", itemId];
}

async function loadRecord(itemId: string, sequence?: string): Promise<InboxItemData> {
	if (itemId.startsWith("status:")) {
		return reportToItem((await api.getStatusReport(itemId.slice(7))).report);
	}
	if (itemId.startsWith("activity:") || itemId.startsWith("event:")) {
		const { event } = await api.getWorkbenchInboxEvent(itemId, sequence);
		if (itemId.startsWith("event:")) {
			const projection = projectRecentEvent(event, 0);
			return { ...projection, item: { ...projection.item, id: itemId } };
		}
		const actor = typeof event.data.actor === "string" ? event.data.actor : event.armId || "system";
		const entry = { id: itemId.slice(9), sequence: event.sequence ?? null, timestamp: event.timestamp,
			actor, action: event.type, target: typeof event.data.target === "string" ? event.data.target : event.armId || null,
			details: event.data };
		return actor === "brain" ? brainActivityToItem(entry) : activityToItem(entry);
	}
	return workbenchInboxToItem((await api.getWorkbenchInboxRecord(itemId)).item);
}

export async function loadInboxItem(itemId: string, sequence?: string): Promise<InboxItemData> {
	const [entry, { attention }] = await Promise.all([
		loadRecord(itemId, sequence), api.getWorkbenchItemAttention(itemId),
	]);
	if (!attention) return entry;
	return { ...entry, item: { ...entry.item,
		unread: attention.readAt ? false : entry.item.unread,
		requiresAction: attention.resolvedAt ? false : attention.requiresAction || entry.item.requiresAction,
	} };
}
