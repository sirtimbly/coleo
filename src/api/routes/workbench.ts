/**
 * Workbench persistence routes.
 *
 * These endpoints persist portable UI profiles, projection definitions, and
 * Golden Layout workspaces. They intentionally do not modify project-domain
 * resources, plans, events, or Arm metric samples.
 */

import { randomUUID } from "crypto";
import { Hono } from "hono";

import { HttpError } from "../middleware";
import { broadcast } from "../websocket";

import type { Database } from "bun:sqlite";

interface WorkbenchContext {
	Variables: {
		db: Database;
	};
}

type JsonRecord = Record<string, unknown>;

interface ProfileRow {
	id: string;
	name: string;
	email: string | null;
	isDefault: number;
	preferences: string;
	createdAt: string;
	updatedAt: string;
}

interface ViewRow {
	id: string;
	profileId: string;
	key: string;
	name: string;
	description: string | null;
	kind: string;
	resourceKind: string | null;
	query: string;
	preferences: string;
	shared: number;
	version: number;
	createdAt: string;
	updatedAt: string;
}

interface LayoutRow {
	id: string;
	profileId: string;
	name: string;
	description: string | null;
	layout: string;
	isDefault: number;
	shared: number;
	version: number;
	createdAt: string;
	updatedAt: string;
}

const VIEW_KINDS = new Set([
	"sheet",
	"inbox",
	"timeline",
	"conversation",
	"process",
	"document",
	"dashboard",
	"inspector",
]);

function parseObject(value: string): JsonRecord {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as JsonRecord
			: {};
	} catch {
		return {};
	}
}

function requireObject(value: unknown, field: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw HttpError.badRequest(`${field} must be an object`);
	}
	return value as JsonRecord;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value: unknown, field: string): string {
	const result = optionalString(value);
	if (!result) throw HttpError.badRequest(`${field} is required`);
	return result;
}

function mapProfile(row: ProfileRow) {
	return {
		id: row.id,
		name: row.name,
		email: row.email ?? undefined,
		isDefault: row.isDefault === 1,
		preferences: parseObject(row.preferences),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapView(row: ViewRow) {
	return {
		id: row.id,
		profileId: row.profileId,
		key: row.key,
		name: row.name,
		description: row.description ?? undefined,
		kind: row.kind,
		resourceKind: row.resourceKind ?? undefined,
		query: parseObject(row.query),
		preferences: parseObject(row.preferences),
		shared: row.shared === 1,
		version: row.version,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapLayout(row: LayoutRow) {
	return {
		id: row.id,
		profileId: row.profileId,
		name: row.name,
		description: row.description ?? undefined,
		layout: parseObject(row.layout),
		isDefault: row.isDefault === 1,
		shared: row.shared === 1,
		version: row.version,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function getProfile(db: Database, profileId: string): ProfileRow {
	const profile = db.query(
		`SELECT id, name, email, is_default AS isDefault, preferences,
		        created_at AS createdAt, updated_at AS updatedAt
		 FROM workbench_profiles WHERE id = ?`,
	).get(profileId) as ProfileRow | null;
	if (!profile) throw HttpError.notFound(`Workbench profile not found: ${profileId}`);
	return profile;
}

function listViews(db: Database, profileId: string, includeShared: boolean): ViewRow[] {
	return db.query(
		`SELECT id, profile_id AS profileId, view_key AS key, name, description, kind,
		        resource_kind AS resourceKind, query, preferences, shared, version,
		        created_at AS createdAt, updated_at AS updatedAt
		 FROM workbench_views
		 WHERE profile_id = ?${includeShared ? " OR shared = 1" : ""}
		 ORDER BY name COLLATE NOCASE`,
	).all(profileId) as ViewRow[];
}

function listLayouts(db: Database, profileId: string, includeShared: boolean): LayoutRow[] {
	return db.query(
		`SELECT id, profile_id AS profileId, name, description, layout,
		        is_default AS isDefault, shared, version,
		        created_at AS createdAt, updated_at AS updatedAt
		 FROM workbench_layouts
		 WHERE profile_id = ?${includeShared ? " OR shared = 1" : ""}
		 ORDER BY is_default DESC, name COLLATE NOCASE`,
	).all(profileId) as LayoutRow[];
}

function broadcastChange(entity: "profile" | "view" | "layout", action: string, data: JsonRecord): void {
	broadcast("workbench", `workbench.${entity}.${action}`, data);
}

export function createWorkbenchRoutes() {
	const app = new Hono<WorkbenchContext>();

	app.get("/bootstrap", (c) => {
		const db = c.get("db");
		const requestedProfileId = c.req.query("profileId");
		const profile = requestedProfileId
			? getProfile(db, requestedProfileId)
			: db.query(
				`SELECT id, name, email, is_default AS isDefault, preferences,
				        created_at AS createdAt, updated_at AS updatedAt
				 FROM workbench_profiles ORDER BY is_default DESC, created_at LIMIT 1`,
			).get() as ProfileRow | null;
		if (!profile) throw HttpError.notFound("No workbench profile is configured");

		return c.json({
			schemaVersion: 1,
			profile: mapProfile(profile),
			views: listViews(db, profile.id, true).map(mapView),
			layouts: listLayouts(db, profile.id, true).map(mapLayout),
		});
	});

	app.get("/profiles", (c) => {
		const db = c.get("db");
		const rows = db.query(
			`SELECT id, name, email, is_default AS isDefault, preferences,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM workbench_profiles ORDER BY is_default DESC, name COLLATE NOCASE`,
		).all() as ProfileRow[];
		return c.json({ profiles: rows.map(mapProfile) });
	});

	app.post("/profiles", async (c) => {
		const db = c.get("db");
		const body = await c.req.json<JsonRecord>();
		const id = optionalString(body.id) ?? randomUUID();
		const name = requiredString(body.name, "name");
		const email = optionalString(body.email);
		const preferences = body.preferences === undefined
			? {}
			: requireObject(body.preferences, "preferences");
		const isDefault = body.isDefault === true;
		const now = new Date().toISOString();

		const create = db.transaction(() => {
			if (isDefault) db.run("UPDATE workbench_profiles SET is_default = 0");
			db.run(
				`INSERT INTO workbench_profiles
				 (id, name, email, is_default, preferences, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[id, name, email, isDefault ? 1 : 0, JSON.stringify(preferences), now, now],
			);
		});
		try {
			create();
		} catch (error) {
			throw HttpError.badRequest(`Could not create workbench profile: ${String(error)}`);
		}

		const profile = mapProfile(getProfile(db, id));
		broadcastChange("profile", "created", { profileId: id });
		return c.json({ profile }, 201);
	});

	app.patch("/profiles/:id", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const current = getProfile(db, id);
		const body = await c.req.json<JsonRecord>();
		const name = body.name === undefined ? current.name : requiredString(body.name, "name");
		const email = body.email === undefined ? current.email : optionalString(body.email);
		const preferences = body.preferences === undefined
			? parseObject(current.preferences)
			: requireObject(body.preferences, "preferences");
		const isDefault = body.isDefault === undefined ? current.isDefault === 1 : body.isDefault === true;
		const now = new Date().toISOString();

		const update = db.transaction(() => {
			if (isDefault) db.run("UPDATE workbench_profiles SET is_default = 0");
			db.run(
				`UPDATE workbench_profiles
				 SET name = ?, email = ?, is_default = ?, preferences = ?, updated_at = ?
				 WHERE id = ?`,
				[name, email, isDefault ? 1 : 0, JSON.stringify(preferences), now, id],
			);
		});
		update();

		broadcastChange("profile", "updated", { profileId: id });
		return c.json({ profile: mapProfile(getProfile(db, id)) });
	});

	app.get("/profiles/:id/export", (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		return c.json({
			bundle: {
				schemaVersion: 1,
				exportedAt: new Date().toISOString(),
				profile: mapProfile(getProfile(db, id)),
				views: listViews(db, id, false).map(mapView),
				layouts: listLayouts(db, id, false).map(mapLayout),
			},
		});
	});

	app.post("/profiles/import", async (c) => {
		const db = c.get("db");
		const body = await c.req.json<JsonRecord>();
		const bundle = requireObject(body.bundle, "bundle");
		const profileInput = requireObject(bundle.profile, "bundle.profile");
		const importedProfileId = requiredString(profileInput.id, "bundle.profile.id");
		const copyMode = body.mode === "copy";
		const profileId = copyMode ? randomUUID() : importedProfileId;
		const now = new Date().toISOString();
		const views = Array.isArray(bundle.views) ? bundle.views : [];
		const layouts = Array.isArray(bundle.layouts) ? bundle.layouts : [];

		const importBundle = db.transaction(() => {
			db.run(
				`INSERT INTO workbench_profiles
				 (id, name, email, is_default, preferences, created_at, updated_at)
				 VALUES (?, ?, ?, 0, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				 name = excluded.name, email = excluded.email,
				 preferences = excluded.preferences, updated_at = excluded.updated_at`,
				[
					profileId,
					copyMode
						? `${requiredString(profileInput.name, "bundle.profile.name")} (imported)`
						: requiredString(profileInput.name, "bundle.profile.name"),
					copyMode ? null : optionalString(profileInput.email),
					JSON.stringify(profileInput.preferences && typeof profileInput.preferences === "object"
						? profileInput.preferences
						: {}),
					now,
					now,
				],
			);
			db.run("DELETE FROM workbench_views WHERE profile_id = ?", [profileId]);
			db.run("DELETE FROM workbench_layouts WHERE profile_id = ?", [profileId]);

			for (const rawView of views) {
				const view = requireObject(rawView, "bundle.views[]");
				const kind = requiredString(view.kind, "bundle.views[].kind");
				if (!VIEW_KINDS.has(kind)) throw HttpError.badRequest(`Unsupported view kind: ${kind}`);
				db.run(
					`INSERT INTO workbench_views
					 (id, profile_id, view_key, name, description, kind, resource_kind, query,
					  preferences, shared, version, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						copyMode ? randomUUID() : requiredString(view.id, "bundle.views[].id"),
						profileId,
						optionalString(view.key) ?? requiredString(view.id, "bundle.views[].id"),
						requiredString(view.name, "bundle.views[].name"),
						optionalString(view.description),
						kind,
						optionalString(view.resourceKind),
						JSON.stringify(view.query && typeof view.query === "object" ? view.query : {}),
						JSON.stringify(view.preferences && typeof view.preferences === "object"
							? view.preferences
							: {}),
						view.shared === true ? 1 : 0,
						typeof view.version === "number" ? view.version : 1,
						now,
						now,
					],
				);
			}

			for (const rawLayout of layouts) {
				const layout = requireObject(rawLayout, "bundle.layouts[]");
				db.run(
					`INSERT INTO workbench_layouts
					 (id, profile_id, name, description, layout, is_default, shared,
					  version, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						copyMode ? randomUUID() : requiredString(layout.id, "bundle.layouts[].id"),
						profileId,
						requiredString(layout.name, "bundle.layouts[].name"),
						optionalString(layout.description),
						JSON.stringify(requireObject(layout.layout, "bundle.layouts[].layout")),
						layout.isDefault === true ? 1 : 0,
						layout.shared === true ? 1 : 0,
						typeof layout.version === "number" ? layout.version : 1,
						now,
						now,
					],
				);
			}
		});
		importBundle();

		broadcastChange("profile", "imported", { profileId });
		return c.json({
			profile: mapProfile(getProfile(db, profileId)),
			views: listViews(db, profileId, false).map(mapView),
			layouts: listLayouts(db, profileId, false).map(mapLayout),
		}, 201);
	});

	app.get("/views", (c) => {
		const db = c.get("db");
		const profileId = c.req.query("profileId") ?? "local";
		getProfile(db, profileId);
		return c.json({
			views: listViews(db, profileId, c.req.query("includeShared") !== "false").map(mapView),
		});
	});

	app.post("/views", async (c) => {
		const db = c.get("db");
		const body = await c.req.json<JsonRecord>();
		const id = optionalString(body.id) ?? randomUUID();
		const profileId = optionalString(body.profileId) ?? "local";
		const kind = requiredString(body.kind, "kind");
		if (!VIEW_KINDS.has(kind)) throw HttpError.badRequest(`Unsupported view kind: ${kind}`);
		getProfile(db, profileId);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO workbench_views
			 (id, profile_id, view_key, name, description, kind, resource_kind, query,
			  preferences, shared, version, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			[
				id,
				profileId,
				optionalString(body.key) ?? id,
				requiredString(body.name, "name"),
				optionalString(body.description),
				kind,
				optionalString(body.resourceKind),
				JSON.stringify(body.query === undefined ? {} : requireObject(body.query, "query")),
				JSON.stringify(body.preferences === undefined
					? {}
					: requireObject(body.preferences, "preferences")),
				body.shared === true ? 1 : 0,
				now,
				now,
			],
		);
		const row = db.query(
			`SELECT id, profile_id AS profileId, view_key AS key, name, description, kind,
			        resource_kind AS resourceKind, query, preferences, shared, version,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM workbench_views WHERE id = ?`,
		).get(id) as ViewRow;
		broadcastChange("view", "created", { profileId, viewId: id });
		return c.json({ view: mapView(row) }, 201);
	});

	app.put("/views/:id", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const current = db.query(
			`SELECT id, profile_id AS profileId, view_key AS key, name, description, kind,
			        resource_kind AS resourceKind, query, preferences, shared, version,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM workbench_views WHERE id = ?`,
		).get(id) as ViewRow | null;
		if (!current) throw HttpError.notFound(`Saved view not found: ${id}`);
		const body = await c.req.json<JsonRecord>();
		const kind = body.kind === undefined ? current.kind : requiredString(body.kind, "kind");
		if (!VIEW_KINDS.has(kind)) throw HttpError.badRequest(`Unsupported view kind: ${kind}`);
		const now = new Date().toISOString();
		db.run(
			`UPDATE workbench_views
			 SET view_key = ?, name = ?, description = ?, kind = ?, resource_kind = ?, query = ?,
			     preferences = ?, shared = ?, version = version + 1, updated_at = ?
			 WHERE id = ?`,
			[
				body.key === undefined ? current.key : requiredString(body.key, "key"),
				body.name === undefined ? current.name : requiredString(body.name, "name"),
				body.description === undefined ? current.description : optionalString(body.description),
				kind,
				body.resourceKind === undefined ? current.resourceKind : optionalString(body.resourceKind),
				JSON.stringify(body.query === undefined
					? parseObject(current.query)
					: requireObject(body.query, "query")),
				JSON.stringify(body.preferences === undefined
					? parseObject(current.preferences)
					: requireObject(body.preferences, "preferences")),
				body.shared === undefined ? current.shared : body.shared === true ? 1 : 0,
				now,
				id,
			],
		);
		broadcastChange("view", "updated", { profileId: current.profileId, viewId: id });
		return c.json({ view: mapView(db.query(
			`SELECT id, profile_id AS profileId, view_key AS key, name, description, kind,
			        resource_kind AS resourceKind, query, preferences, shared, version,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM workbench_views WHERE id = ?`,
		).get(id) as ViewRow) });
	});

	app.delete("/views/:id", (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const current = db.query("SELECT profile_id AS profileId FROM workbench_views WHERE id = ?")
			.get(id) as { profileId: string } | null;
		if (!current) throw HttpError.notFound(`Saved view not found: ${id}`);
		db.run("DELETE FROM workbench_views WHERE id = ?", [id]);
		broadcastChange("view", "deleted", { profileId: current.profileId, viewId: id });
		return c.json({ success: true });
	});

	app.get("/layouts", (c) => {
		const db = c.get("db");
		const profileId = c.req.query("profileId") ?? "local";
		getProfile(db, profileId);
		return c.json({
			layouts: listLayouts(db, profileId, c.req.query("includeShared") !== "false").map(mapLayout),
		});
	});

	app.put("/layouts/:id", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const body = await c.req.json<JsonRecord>();
		const profileId = optionalString(body.profileId) ?? "local";
		getProfile(db, profileId);
		const name = optionalString(body.name) ?? "Current workspace";
		const layout = requireObject(body.layout, "layout");
		const isDefault = body.isDefault !== false;
		const now = new Date().toISOString();

		const save = db.transaction(() => {
			if (isDefault) {
				db.run("UPDATE workbench_layouts SET is_default = 0 WHERE profile_id = ?", [profileId]);
			}
			db.run(
				`INSERT INTO workbench_layouts
				 (id, profile_id, name, description, layout, is_default, shared,
				  version, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   profile_id = excluded.profile_id,
				   name = excluded.name,
				   description = excluded.description,
				   layout = excluded.layout,
				   is_default = excluded.is_default,
				   shared = excluded.shared,
				   version = workbench_layouts.version + 1,
				   updated_at = excluded.updated_at`,
				[
					id,
					profileId,
					name,
					optionalString(body.description),
					JSON.stringify(layout),
					isDefault ? 1 : 0,
					body.shared === true ? 1 : 0,
					now,
					now,
				],
			);
		});
		save();
		const row = db.query(
			`SELECT id, profile_id AS profileId, name, description, layout,
			        is_default AS isDefault, shared, version,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM workbench_layouts WHERE id = ?`,
		).get(id) as LayoutRow;
		broadcastChange("layout", "saved", { profileId, layoutId: id });
		return c.json({ layout: mapLayout(row) });
	});

	app.delete("/layouts/:id", (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const current = db.query("SELECT profile_id AS profileId FROM workbench_layouts WHERE id = ?")
			.get(id) as { profileId: string } | null;
		if (!current) throw HttpError.notFound(`Workspace layout not found: ${id}`);
		db.run("DELETE FROM workbench_layouts WHERE id = ?", [id]);
		broadcastChange("layout", "deleted", { profileId: current.profileId, layoutId: id });
		return c.json({ success: true });
	});

	return app;
}
