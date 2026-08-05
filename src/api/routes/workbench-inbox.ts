import { Hono } from "hono";

import { HttpError } from "../middleware";

import type { Database } from "bun:sqlite";
import type { WorkbenchAttention, WorkbenchInboxRecord } from "../../types/adaptive-cards";

interface InboxContext {
	Variables: { db: Database };
}

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

interface AttentionRow {
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

function encodeCursor(timestamp: string, itemKey: string): string {
	return Buffer.from(JSON.stringify([timestamp, itemKey])).toString("base64url");
}

function decodeCursor(value: string | undefined): [string, string] | null {
	if (!value) return null;
	try {
		const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
		if (
			Array.isArray(decoded) &&
			decoded.length === 2 &&
			typeof decoded[0] === "string" &&
			typeof decoded[1] === "string"
		) {
			return [decoded[0], decoded[1]];
		}
		throw HttpError.badRequest("Invalid inbox cursor");
	} catch {
		throw HttpError.badRequest("Invalid inbox cursor");
	}
}

function mapAttention(row: AttentionRow): WorkbenchAttention {
	return {
		profileId: row.profileId,
		itemKey: row.itemKey,
		seenAt: row.seenAt ?? undefined,
		readAt: row.readAt ?? undefined,
		archivedAt: row.archivedAt ?? undefined,
		snoozedUntil: row.snoozedUntil ?? undefined,
		resolvedAt: row.resolvedAt ?? undefined,
		assignedTo: row.assignedTo ?? undefined,
		requiresAction: row.requiresAction === 1,
		updatedAt: row.updatedAt,
	};
}

export function createWorkbenchInboxRoutes() {
	const app = new Hono<InboxContext>();

	app.get("/", (c) => {
		const db = c.get("db");
		const profileId = c.req.query("profileId") ?? "local";
		if (!db.query("SELECT id FROM workbench_profiles WHERE id = ?").get(profileId)) {
			throw HttpError.notFound(`Workbench profile not found: ${profileId}`);
		}
		const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 200);
		const cursor = decodeCursor(c.req.query("cursor"));
		const sourceLimit = Math.min(limit * 2, 400);
		const rows: SourceRow[] = [
			...(db.query(
				`SELECT 'status:' || id AS itemKey, 'status-report' AS source, 'status' AS kind,
				        arm_id || ': ' || replace(status, '_', ' ') AS title,
				        summary, created_at AS timestamp, 'task' AS resourceKind,
				        task_id AS resourceId,
				        CASE WHEN status = 'blocked' THEN 'danger'
				             WHEN status IN ('issues_found', 'needs_review') THEN 'warning'
				             ELSE 'info' END AS severity,
				        CASE WHEN status IN ('blocked', 'issues_found', 'needs_review') THEN 1 ELSE 0 END AS requiresAction
				 FROM status_reports ORDER BY created_at DESC LIMIT ?`,
			).all(sourceLimit) as SourceRow[]),
			...(db.query(
				`SELECT 'task:' || id AS itemKey, 'task' AS source, 'task' AS kind,
				        subject AS title, substr(description, 1, 500) AS summary,
				        updated_at AS timestamp, 'task' AS resourceKind, id AS resourceId,
				        CASE WHEN status = 'failed' THEN 'danger' ELSE 'warning' END AS severity,
				        1 AS requiresAction
				 FROM tasks WHERE status IN ('blocked', 'failed')
				 ORDER BY updated_at DESC LIMIT ?`,
			).all(sourceLimit) as SourceRow[]),
			...(db.query(
				`SELECT 'bug:' || id AS itemKey, 'bug' AS source, 'bug' AS kind,
				        title, substr(description, 1, 500) AS summary,
				        updated_at AS timestamp, 'bug' AS resourceKind, id AS resourceId,
				        CASE WHEN priority = 'critical' THEN 'danger' ELSE 'warning' END AS severity,
				        1 AS requiresAction
				 FROM bugs
				 WHERE archived = 0 AND priority IN ('critical', 'high')
				   AND status NOT IN ('resolved', 'closed')
				 ORDER BY updated_at DESC LIMIT ?`,
			).all(sourceLimit) as SourceRow[]),
		];
		const attentionRows = db.query(
			`SELECT profile_id AS profileId, item_key AS itemKey,
			        seen_at AS seenAt, read_at AS readAt, archived_at AS archivedAt,
			        snoozed_until AS snoozedUntil, resolved_at AS resolvedAt,
			        assigned_to AS assignedTo, requires_action AS requiresAction,
			        updated_at AS updatedAt
			 FROM workbench_attention WHERE profile_id = ?`,
		).all(profileId) as AttentionRow[];
		const attention = new Map(attentionRows.map((row) => [row.itemKey, mapAttention(row)]));
		const now = Date.now();
		const records = rows
			.filter((row) => !cursor ||
				row.timestamp < cursor[0] ||
				(row.timestamp === cursor[0] && row.itemKey < cursor[1]))
			.filter((row) => {
				const state = attention.get(row.itemKey);
				return !state?.archivedAt &&
					(!state?.snoozedUntil || Date.parse(state.snoozedUntil) <= now);
			})
			.sort((left, right) =>
				right.timestamp.localeCompare(left.timestamp) ||
				right.itemKey.localeCompare(left.itemKey)
			)
			.slice(0, limit)
			.map((row): WorkbenchInboxRecord => ({
				itemKey: row.itemKey,
				source: row.source,
				kind: row.kind,
				title: row.title,
				summary: row.summary,
				timestamp: row.timestamp,
				resource: { kind: row.resourceKind, id: row.resourceId },
				severity: row.severity,
				requiresAction: attention.get(row.itemKey)?.resolvedAt
					? false
					: row.requiresAction === 1,
				attention: attention.get(row.itemKey),
			}));
		const last = records.at(-1);
		return c.json({
			items: records,
			nextCursor: records.length === limit && last
				? encodeCursor(last.timestamp, last.itemKey)
				: undefined,
		});
	});

	return app;
}
