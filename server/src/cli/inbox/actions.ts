import { z } from "zod";
import { hierarchySubtreeIds, indexResourceHierarchy } from "../../workbench/resource-hierarchy";
import { resolveInboxReference } from "./references";

import type { InboxApi } from "./api";
import type { InboxSnapshot } from "./snapshot";
import type { MessagingItem } from "../../workbench/messaging-collection";
import type { MessagingReferenceTarget } from "../../workbench/resource-reference";

/** Resolve a full ID or short reference only within the loaded snapshot used for this action. */
function locate(snapshot: InboxSnapshot, id: string): { item: MessagingItem; member?: string } {
	id = resolveInboxReference(snapshot.items.flatMap((item) => [item.id,
		...item.thread?.hierarchy.nodes.filter((node) => node.selectable).map((node) => node.id) ?? []]), id);
	for (const item of snapshot.items) {
		if (item.id === id) return { item };
		if (item.thread?.hierarchy.nodes.some((node) => node.id === id && node.selectable)) return { item, member: id };
	}
	throw new Error(`Read selection is not loaded in this view/window: ${id}. List the intended window and repeat its query options for mark-read.`);
}

/** Fetch the targeted detail resource selected by the filter-independent reference lookup. */
export async function inspectInboxReference(api: InboxApi, target: MessagingReferenceTarget, profileId: string): Promise<unknown> {
	const detail = target.detail;
	if (detail.kind === "thread" || detail.kind === "message") {
		return api.request(`/api/mail/threads/${encodeURIComponent(detail.threadId)}${detail.kind === "message" ? `/messages/${encodeURIComponent(detail.messageId)}` : ""}?mailbox=${detail.mailbox}`);
	}
	if (detail.kind === "event" || detail.kind === "activity") {
		return api.request(`/api/workbench/inbox/events/${encodeURIComponent(target.id)}${detail.sequence ? `?sequence=${detail.sequence}` : ""}`);
	}
	if (target.id.startsWith("status:")) return api.request(`/api/status-reports/${encodeURIComponent(target.id.slice(7))}`);
	return api.request(`/api/workbench/inbox/records/${encodeURIComponent(target.id)}?profileId=${encodeURIComponent(profileId)}`);
}

export interface InboxReadResult {
	readonly selectedMemberIds: readonly string[];
	readonly completedItemIds: readonly string[];
	readonly completedMessageIds: readonly string[];
	readonly skippedMemberIds: readonly string[];
	readonly error?: string;
}

/** Mark explicitly resolved loaded targets as read, reporting completed writes if a later request fails. */
export async function markInboxSelectionRead(api: InboxApi, snapshot: InboxSnapshot, ids: readonly string[], branches = false): Promise<InboxReadResult> {
	if (!snapshot.complete) throw new Error("Cannot act on an incomplete Inbox window. Retry the read before selecting IDs.");
	// Resolve every requested target before any write; group selection expands only the loaded snapshot.
	const targets = ids.map((id) => locate(snapshot, id));
	const records = new Set<string>();
	const threads = new Map<string, { item: MessagingItem; ids: Set<string> }>();
	for (const { item, member } of targets) {
		if (!item.thread) { records.add(item.id); continue; }
		const entry = threads.get(item.id) ?? { item, ids: new Set<string>() };
		const index = indexResourceHierarchy(item.thread.hierarchy);
		const selected = (member ? branches ? hierarchySubtreeIds(index, member) : [member]
			: item.thread.hierarchy.rootIds.flatMap((root) => hierarchySubtreeIds(index, root))).filter((id) => index.byId.get(id)!.selectable);
		for (const id of selected) entry.ids.add(id);
		if (entry.ids.size > 1000) throw new Error("A thread action accepts at most 1000 members. Select a smaller set of explicit message IDs.");
		threads.set(item.id, entry);
	}
	const completedItems: string[] = [], completedMessages: string[] = [], skipped: string[] = [];
	const selectedMemberIds = [...new Set([...threads.values()].flatMap((thread) => [...thread.ids]))];
	try {
		for (const { item, ids: members } of threads.values()) {
			const thread = item.thread!;
			const response = z.object({ ok: z.literal(true), completedMessageIds: z.array(z.string()), skippedMemberIds: z.array(z.string()) }).parse(
				await api.request(`/api/mail/threads/${encodeURIComponent(thread.id)}/actions`,
					{ mailbox: thread.mailbox, revision: thread.revision, memberIds: [...members], action: "read" }));
			completedItems.push(item.id); completedMessages.push(...response.completedMessageIds); skipped.push(...response.skippedMemberIds);
		}
		const recordIds = [...records];
		for (let index = 0; index < recordIds.length; index += 500) {
			const batch = recordIds.slice(index, index + 500);
			await api.request("/api/workbench/attention/bulk", { profileId: snapshot.query.profileId, itemKeys: batch, action: "read" });
			completedItems.push(...batch);
		}
	} catch (error) {
		return { selectedMemberIds, completedItemIds: completedItems, completedMessageIds: completedMessages, skippedMemberIds: skipped,
			error: error instanceof Error ? error.message : "Action failed; reload before retrying" };
	}
	return { selectedMemberIds, completedItemIds: completedItems, completedMessageIds: completedMessages, skippedMemberIds: skipped };
}
