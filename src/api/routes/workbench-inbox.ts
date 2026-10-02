import { Hono } from "hono";

import { HttpError } from "../middleware";
import { listWorkbenchInboxPage, mapInboxAttention } from "../workbench-inbox-page";
import { sanitizeEventData } from "./events";
import { getInboxEventRecord } from "./inbox-event-record";
import { getWorkbenchInboxRecord } from "./workbench-inbox-record";

import type { Database } from "bun:sqlite";
import type { InboxAttentionRow } from "../workbench-inbox-page";

interface InboxContext {
	Variables: { db: Database };
}

export function createWorkbenchInboxRoutes() {
	const app = new Hono<InboxContext>();

	app.get("/events/:itemKey", async (c) => {
		const event = await getInboxEventRecord(c.req.param("itemKey"), c.req.query("sequence"));
		return c.json({ event: { type: event.type, timestamp: event.timestamp,
			armId: event.armId, sequence: event.sequence, data: sanitizeEventData(event.data) } });
	});

	app.get("/records/:itemKey", (c) => {
		const db = c.get("db");
		const itemKey = c.req.param("itemKey");
		const profileId = c.req.query("profileId") ?? "local";
		if (!db.query("SELECT id FROM workbench_profiles WHERE id = ?").get(profileId)) {
			throw HttpError.notFound(`Workbench profile not found: ${profileId}`);
		}
		const item = getWorkbenchInboxRecord(db, itemKey);
		const row = db.query(`SELECT profile_id AS profileId, item_key AS itemKey,
			seen_at AS seenAt, read_at AS readAt, archived_at AS archivedAt,
			snoozed_until AS snoozedUntil, resolved_at AS resolvedAt, assigned_to AS assignedTo,
			requires_action AS requiresAction, updated_at AS updatedAt
			FROM workbench_attention WHERE profile_id = ? AND item_key = ?`).get(profileId, itemKey) as InboxAttentionRow | null;
		if (row) {
			item.attention = mapInboxAttention(row);
			if (row.resolvedAt) item.requiresAction = false;
		}
		return c.json({ item });
	});

	app.get("/", (c) => {
		const db = c.get("db");
		const profileId = c.req.query("profileId") ?? "local";
		if (!db.query("SELECT id FROM workbench_profiles WHERE id = ?").get(profileId)) {
			throw HttpError.notFound(`Workbench profile not found: ${profileId}`);
		}
		return c.json(listWorkbenchInboxPage(db, profileId, c.req.query("limit"), c.req.query("cursor")));
	});

	return app;
}
