import { z } from "zod";

import { compareMessagingPositions } from "../workbench/messaging-query";
import { inboxSourceWindowSql } from "./inbox-source-window";
import { HttpError } from "./middleware";
import { listSwarmInboxRecords } from "./swarm-inbox";

import type { Database } from "bun:sqlite";
import type { WorkbenchAttention, WorkbenchInboxRecord } from "../types/adaptive-cards";
import type { MessagingPosition } from "../workbench/messaging-query";

interface SourceRow {
	itemKey: string;
	source: WorkbenchInboxRecord["source"];
	kind: WorkbenchInboxRecord["kind"];
	title: string;
	summary: string;
	timestamp: string;
	resourceKind: string;
	resourceId: string;
	severity: WorkbenchInboxRecord["severity"];
	requiresAction: number;
}

export interface InboxAttentionRow {
	profileId: string;
	itemKey: string;
	seenAt: string | null;
	readAt: string | null;
	archivedAt: string | null;
	snoozedUntil: string | null;
	resolvedAt: string | null;
	assignedTo: string | null;
	requiresAction: number;
	updatedAt: string;
}

export function mapInboxAttention(row: InboxAttentionRow): WorkbenchAttention {
	return {
		profileId: row.profileId, itemKey: row.itemKey,
		seenAt: row.seenAt ?? undefined, readAt: row.readAt ?? undefined,
		archivedAt: row.archivedAt ?? undefined, snoozedUntil: row.snoozedUntil ?? undefined,
		resolvedAt: row.resolvedAt ?? undefined, assignedTo: row.assignedTo ?? undefined,
		requiresAction: row.requiresAction === 1, updatedAt: row.updatedAt,
	};
}

const cursorSchema = z.object({
	schemaVersion: z.literal(1), projection: z.literal("durable-inbox"), profileId: z.string().min(1),
	before: z.object({ timestamp: z.iso.datetime(), id: z.string().min(1) }).strict(),
}).strict();

function decodeCursor(value: string | undefined, profileId: string): MessagingPosition | null {
	if (value === undefined) return null;
	try {
		if (!value || value.length > 8192) throw new Error("Invalid cursor length");
		const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
		if (cursor.profileId !== profileId) throw new Error("Cursor belongs to another profile");
		return cursor.before;
	} catch {
		throw HttpError.badRequest("Invalid inbox cursor");
	}
}

const SOURCE_ROWS_SQL = `
	SELECT 'brain:planning-gate' AS itemKey, 'planning-gate' AS source,
		'brain' AS kind, 'Project planning is blocked' AS title, error AS summary,
		last_check AS timestamp, 'brain' AS resourceKind, 'planning-gate' AS resourceId,
		'danger' AS severity, 1 AS requiresAction
	FROM infrastructure_health WHERE component = 'brain_planning_gate' AND healthy = 0
	UNION ALL
	SELECT 'status:' || id, 'status-report', 'status', arm_id || ': ' || replace(status, '_', ' '),
		summary, created_at, 'task', task_id,
		CASE WHEN status = 'blocked' THEN 'danger' WHEN status IN ('issues_found', 'needs_review') THEN 'warning' ELSE 'info' END,
		CASE WHEN status IN ('blocked', 'issues_found', 'needs_review') THEN 1 ELSE 0 END
	FROM status_reports
	UNION ALL
	SELECT 'task:' || id, 'task', 'task', subject, substr(description, 1, 500), updated_at, 'task', id,
		CASE WHEN status = 'failed' THEN 'danger' ELSE 'warning' END, 1
	FROM tasks WHERE status IN ('blocked', 'failed')
		AND (status != 'blocked' OR blocked_category IS NULL OR blocked_category != 'planning')
	UNION ALL
	SELECT 'bug:' || id, 'bug', 'bug', title, substr(description, 1, 500), updated_at, 'bug', id,
		CASE WHEN priority = 'critical' THEN 'danger' ELSE 'warning' END, 1
	FROM bugs WHERE archived = 0 AND priority IN ('critical', 'high') AND status NOT IN ('resolved', 'closed')
`;

/** Legacy durable-record subset. Full Messaging adapters will evolve this endpoint in the next slice. */
export function listWorkbenchInboxPage(
	db: Database,
	profileId: string,
	limitInput: string | undefined,
	cursorInput: string | undefined,
): { items: WorkbenchInboxRecord[]; nextCursor?: string } {
	const requestedLimit = limitInput === undefined ? 100 : Number(limitInput);
	if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
		throw HttpError.badRequest("Inbox limit must be a positive integer");
	}
	const limit = Math.min(requestedLimit, 200);
	const before = decodeCursor(cursorInput, profileId);
	const window = { before, visibility: { profileId, now: new Date().toISOString() } };
	const predicate = inboxSourceWindowSql("timestamp", "itemKey", window);

	// Both reads and attention mapping share a SQLite boundary; this says nothing about other stores.
	return db.transaction(() => {
		const rows = db.query(`WITH raw_sources AS (${SOURCE_ROWS_SQL}), sources AS (
			SELECT itemKey, source, kind, title, summary, strftime('%Y-%m-%dT%H:%M:%fZ', timestamp) AS timestamp,
				resourceKind, resourceId, severity, requiresAction FROM raw_sources
		) SELECT * FROM sources WHERE ${predicate.clause}
			ORDER BY timestamp DESC, itemKey COLLATE BINARY DESC LIMIT ?`).all(...predicate.params, limit + 1) as SourceRow[];
		rows.push(...listSwarmInboxRecords(db, limit + 1, window).map((item) => ({
			...item, resourceKind: item.resource.kind, resourceId: item.resource.id, requiresAction: item.requiresAction ? 1 : 0,
		})));
		if (rows.some((row) => typeof row.timestamp !== "string")) throw HttpError.internal("Invalid Inbox source timestamp");
		rows.sort((left, right) => compareMessagingPositions(
			{ timestamp: left.timestamp, id: left.itemKey }, { timestamp: right.timestamp, id: right.itemKey },
		));
		const pageRows = rows.slice(0, limit);
		if (pageRows.length === 0) return { items: [] };
		const attentionRows = db.query(`SELECT profile_id AS profileId, item_key AS itemKey,
			seen_at AS seenAt, read_at AS readAt, archived_at AS archivedAt, snoozed_until AS snoozedUntil,
			resolved_at AS resolvedAt, assigned_to AS assignedTo, requires_action AS requiresAction, updated_at AS updatedAt
			FROM workbench_attention WHERE profile_id = ? AND item_key IN (${pageRows.map(() => "?").join(",")})`)
			.all(profileId, ...pageRows.map((row) => row.itemKey)) as InboxAttentionRow[];
		const attention = new Map(attentionRows.map((row) => [row.itemKey, mapInboxAttention(row)]));
		const items = pageRows.map((row): WorkbenchInboxRecord => ({
			itemKey: row.itemKey, source: row.source, kind: row.kind, title: row.title, summary: row.summary,
			timestamp: row.timestamp, resource: { kind: row.resourceKind, id: row.resourceId }, severity: row.severity,
			requiresAction: !attention.get(row.itemKey)?.resolvedAt && row.requiresAction === 1,
			attention: attention.get(row.itemKey),
		}));
		const last = items.at(-1)!;
		return {
			items,
			nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({
				schemaVersion: 1, projection: "durable-inbox", profileId,
				before: { timestamp: last.timestamp, id: last.itemKey },
			})).toString("base64url") : undefined,
		};
	})();
}
