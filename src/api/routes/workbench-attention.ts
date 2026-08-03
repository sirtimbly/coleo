import { Hono } from "hono";

import { HttpError } from "../middleware";
import { broadcast } from "../websocket";

import type { Database } from "bun:sqlite";

interface AttentionContext {
	Variables: { db: Database };
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

type AttentionField =
	| "seenAt"
	| "readAt"
	| "archivedAt"
	| "snoozedUntil"
	| "resolvedAt"
	| "assignedTo";

const ATTENTION_COLUMNS: Record<AttentionField, string> = {
	seenAt: "seen_at",
	readAt: "read_at",
	archivedAt: "archived_at",
	snoozedUntil: "snoozed_until",
	resolvedAt: "resolved_at",
	assignedTo: "assigned_to",
};

function mapAttention(row: AttentionRow) {
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

function getAttention(db: Database, profileId: string, itemKey: string): AttentionRow | null {
	return db.query(
		`SELECT profile_id AS profileId, item_key AS itemKey,
		        seen_at AS seenAt, read_at AS readAt, archived_at AS archivedAt,
		        snoozed_until AS snoozedUntil, resolved_at AS resolvedAt,
		        assigned_to AS assignedTo, requires_action AS requiresAction,
		        updated_at AS updatedAt
		 FROM workbench_attention WHERE profile_id = ? AND item_key = ?`,
	).get(profileId, itemKey) as AttentionRow | null;
}

function requireProfile(db: Database, profileId: string): void {
	if (!db.query("SELECT id FROM workbench_profiles WHERE id = ?").get(profileId)) {
		throw HttpError.notFound(`Workbench profile not found: ${profileId}`);
	}
}

function optionalTimestamp(value: unknown, field: string): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw HttpError.badRequest(`${field} must be an ISO timestamp or null`);
	}
	return new Date(value).toISOString();
}

export function upsertAttention(
	db: Database,
	input: {
		profileId: string;
		itemKey: string;
		patch: Record<string, unknown>;
	},
) {
	requireProfile(db, input.profileId);
	if (!input.itemKey.trim() || input.itemKey.length > 512) {
		throw HttpError.badRequest("itemKey must contain 1 to 512 characters");
	}
	const current = getAttention(db, input.profileId, input.itemKey);
	const now = new Date().toISOString();
	const values: Record<AttentionField, string | null> = {
		seenAt: current?.seenAt ?? null,
		readAt: current?.readAt ?? null,
		archivedAt: current?.archivedAt ?? null,
		snoozedUntil: current?.snoozedUntil ?? null,
		resolvedAt: current?.resolvedAt ?? null,
		assignedTo: current?.assignedTo ?? null,
	};
	for (const field of Object.keys(ATTENTION_COLUMNS) as AttentionField[]) {
		const value = field === "assignedTo"
			? input.patch[field] === undefined
				? undefined
				: input.patch[field] === null
					? null
					: typeof input.patch[field] === "string"
						? input.patch[field].trim().slice(0, 256) || null
						: (() => { throw HttpError.badRequest("assignedTo must be a string or null"); })()
			: optionalTimestamp(input.patch[field], field);
		if (value !== undefined) values[field] = value;
	}
	const requiresAction = input.patch.requiresAction === undefined
		? current?.requiresAction === 1
		: input.patch.requiresAction === true;

	db.run(
		`INSERT INTO workbench_attention (
		   profile_id, item_key, seen_at, read_at, archived_at, snoozed_until,
		   resolved_at, assigned_to, requires_action, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(profile_id, item_key) DO UPDATE SET
		   seen_at = excluded.seen_at,
		   read_at = excluded.read_at,
		   archived_at = excluded.archived_at,
		   snoozed_until = excluded.snoozed_until,
		   resolved_at = excluded.resolved_at,
		   assigned_to = excluded.assigned_to,
		   requires_action = excluded.requires_action,
		   updated_at = excluded.updated_at`,
		[
			input.profileId,
			input.itemKey,
			values.seenAt,
			values.readAt,
			values.archivedAt,
			values.snoozedUntil,
			values.resolvedAt,
			values.assignedTo,
			requiresAction ? 1 : 0,
			now,
		],
	);
	const row = getAttention(db, input.profileId, input.itemKey);
	if (!row) throw HttpError.internal("Attention state was not persisted");
	return mapAttention(row);
}

export function createWorkbenchAttentionRoutes() {
	const app = new Hono<AttentionContext>();

	app.get("/", (c) => {
		const db = c.get("db");
		const profileId = c.req.query("profileId") ?? "local";
		requireProfile(db, profileId);
		const clauses = ["profile_id = ?"];
		const params: Array<string | number> = [profileId];
		if (c.req.query("requiresAction") === "true") {
			clauses.push("requires_action = 1", "resolved_at IS NULL");
		}
		if (c.req.query("unread") === "true") clauses.push("read_at IS NULL");
		if (c.req.query("includeArchived") !== "true") clauses.push("archived_at IS NULL");
		const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 500), 1), 1000);
		params.push(limit);
		const rows = db.query(
			`SELECT profile_id AS profileId, item_key AS itemKey,
			        seen_at AS seenAt, read_at AS readAt, archived_at AS archivedAt,
			        snoozed_until AS snoozedUntil, resolved_at AS resolvedAt,
			        assigned_to AS assignedTo, requires_action AS requiresAction,
			        updated_at AS updatedAt
			 FROM workbench_attention
			 WHERE ${clauses.join(" AND ")}
			 ORDER BY updated_at DESC LIMIT ?`,
		).all(...params) as AttentionRow[];
		return c.json({ attention: rows.map(mapAttention) });
	});

	app.put("/:itemKey", async (c) => {
		const db = c.get("db");
		const body = await c.req.json<Record<string, unknown>>();
		const profileId = typeof body.profileId === "string" ? body.profileId : "local";
		const itemKey = decodeURIComponent(c.req.param("itemKey"));
		const attention = upsertAttention(db, { profileId, itemKey, patch: body });
		broadcast("workbench", "workbench.attention.updated", { profileId, itemKey });
		return c.json({ attention });
	});

	app.post("/bulk", async (c) => {
		const db = c.get("db");
		const body = await c.req.json<Record<string, unknown>>();
		const profileId = typeof body.profileId === "string" ? body.profileId : "local";
		const itemKeys = Array.isArray(body.itemKeys)
			? body.itemKeys.filter((value): value is string => typeof value === "string")
			: [];
		if (itemKeys.length === 0 || itemKeys.length > 500) {
			throw HttpError.badRequest("itemKeys must contain 1 to 500 strings");
		}
		const action = body.action;
		const now = new Date().toISOString();
		const patch = action === "read"
			? { readAt: now, seenAt: now }
			: action === "archive"
				? { archivedAt: now }
				: action === "resolve"
					? { resolvedAt: now, readAt: now, requiresAction: false }
					: null;
		if (!patch) throw HttpError.badRequest("action must be read, archive, or resolve");
		const attention = db.transaction(() =>
			itemKeys.map((itemKey) => upsertAttention(db, { profileId, itemKey, patch })),
		)();
		broadcast("workbench", "workbench.attention.bulk-updated", {
			profileId,
			itemKeys,
			action,
		});
		return c.json({ attention });
	});

	return app;
}
