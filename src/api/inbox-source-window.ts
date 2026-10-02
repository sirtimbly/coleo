import type { MessagingPosition } from "../workbench/messaging-query";

export interface InboxSourceWindow {
	readonly before?: MessagingPosition | null;
	readonly visibility?: { readonly profileId: string; readonly now: string };
}

/** Expressions are application-owned SQL; every cursor/profile/time value is bound separately. */
export function inboxSourceWindowSql(
	timestampExpression: string,
	itemKeyExpression: string,
	window: InboxSourceWindow,
): { clause: string; params: string[] } {
	const clauses: string[] = [];
	const params: string[] = [];
	if (window.before) {
		clauses.push(`(${timestampExpression} < ? OR
			(${timestampExpression} = ? AND ${itemKeyExpression} COLLATE BINARY < ?))`);
		params.push(window.before.timestamp, window.before.timestamp, window.before.id);
	}
	if (window.visibility) {
		clauses.push(`NOT EXISTS (
			SELECT 1 FROM workbench_attention attention
			WHERE attention.profile_id = ? AND attention.item_key = ${itemKeyExpression}
			AND (attention.archived_at IS NOT NULL OR
				(attention.snoozed_until IS NOT NULL AND
					(julianday(attention.snoozed_until) IS NULL OR julianday(attention.snoozed_until) > julianday(?))))
		)`);
		params.push(window.visibility.profileId, window.visibility.now);
	}
	return { clause: clauses.join(" AND ") || "1", params };
}
