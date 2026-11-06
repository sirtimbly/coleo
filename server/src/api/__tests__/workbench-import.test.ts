import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { initDatabase } from "../../db";
import { formatErrorResponse } from "../middleware/error";
import { createWorkbenchRoutes } from "../routes/workbench";

import type { Database } from "bun:sqlite";

interface Bundle {
	schemaVersion: number;
	profile: Record<string, unknown>;
	views: Array<Record<string, unknown>>;
	layouts: Array<Record<string, unknown>>;
}

describe("portable workbench imports", () => {
	let directory: string;
	let db: Database;
	let app: Hono<{ Variables: { db: Database } }>;
	let bundle: Bundle;

	async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
		return app.request(path, {
			method,
			...(body === undefined ? {} : {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		});
	}

	function savedState(): unknown {
		return ["workbench_profiles", "workbench_views", "workbench_layouts"]
			.map((table) => db.query(`SELECT * FROM ${table} ORDER BY id`).all());
	}

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "coleo-workbench-import-"));
		db = await initDatabase(join(directory, "state.db"));
		app = new Hono<{ Variables: { db: Database } }>();
		app.use("*", async (c, next) => { c.set("db", db); await next(); });
		app.onError((error, c) => formatErrorResponse(c, error));
		app.route("/", createWorkbenchRoutes({ coleoDir: join(directory, ".coleo") }));
		expect((await request("/profiles/local", "PATCH", {
			name: "My workspace", preferences: { theme: "dark", custom: { value: 42 } },
		})).status).toBe(200);
		expect((await request("/views", "POST", {
			id: "tasks", profileId: "local", key: "tasks-sheet", name: "Tasks", kind: "sheet",
			query: { status: "pending" }, preferences: { columns: [{ id: "subject", width: 320 }] },
		})).status).toBe(201);
		expect((await request("/layouts/current", "PUT", {
			profileId: "local", name: "Current", layout: { root: { type: "stack", content: [] } },
		})).status).toBe(200);
		bundle = (await (await request("/profiles/local/export")).json() as { bundle: Bundle }).bundle;
	});

	afterEach(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it("rejects unsupported or missing versions without replacing any saved state", async () => {
		const before = savedState();
		for (const schemaVersion of [undefined, null, 0, 2, "1"]) {
			const response = await request("/profiles/import", "POST", {
				bundle: { ...bundle, schemaVersion, profile: { ...bundle.profile, name: "Changed" } },
			});
			expect(response.status).toBe(400);
			expect((await response.json() as { error: string }).error).toContain("schemaVersion");
			expect(savedState()).toEqual(before);
		}
	});

	it("rejects incomplete or malformed collections and preferences before replacement", async () => {
		const before = savedState();
		const invalidBundles = [
			{ ...bundle, views: undefined },
			{ ...bundle, layouts: undefined },
			{ ...bundle, views: {} },
			{ ...bundle, layouts: null },
			{ ...bundle, profile: { ...bundle.profile, preferences: [] } },
			{ ...bundle, views: [{ ...bundle.views[0], preferences: [] }] },
			{ ...bundle, views: [{ ...bundle.views[0], query: null }] },
			{ ...bundle, views: [{ ...bundle.views[0], kind: "future-renderer" }] },
			{ ...bundle, views: [{ ...bundle.views[0], version: -1 }] },
			{ ...bundle, layouts: [{ ...bundle.layouts[0], layout: [] }] },
			{ ...bundle, views: [...bundle.views, { ...bundle.views[0], id: "duplicate-key" }] },
		];
		for (const invalid of invalidBundles) {
			expect((await request("/profiles/import", "POST", { bundle: invalid })).status).toBe(400);
			expect(savedState()).toEqual(before);
		}
	});

	it("rejects invalid modes and malformed JSON rather than treating them as replacement", async () => {
		const before = savedState();
		expect((await request("/profiles/import", "POST", { bundle, mode: "copi" })).status).toBe(400);
		const invalidJson = await app.request("/profiles/import", {
			method: "POST", headers: { "content-type": "application/json" }, body: "{",
		});
		expect(invalidJson.status).toBe(400);
		expect(savedState()).toEqual(before);
	});

	it("round-trips supported exports in replace and copy modes", async () => {
		const replaced = await request("/profiles/import", "POST", {
			bundle: { ...bundle, profile: { ...bundle.profile, name: "Restored" } }, mode: "replace",
		});
		expect(replaced.status).toBe(201);
		const restored = await replaced.json() as Omit<Bundle, "schemaVersion">;
		expect(restored.profile).toMatchObject({
			id: "local", name: "Restored", preferences: bundle.profile.preferences,
		});
		expect(restored.views[0]).toMatchObject({
			id: "tasks", query: bundle.views[0]!.query, preferences: bundle.views[0]!.preferences,
		});
		expect(restored.layouts[0]).toMatchObject({ id: "current", layout: bundle.layouts[0]!.layout });

		const original = savedState();
		const copied = await request("/profiles/import", "POST", { bundle, mode: "copy" });
		expect(copied.status).toBe(201);
		const copy = await copied.json() as Omit<Bundle, "schemaVersion">;
		expect(copy.profile.id).not.toBe("local");
		expect(copy.profile.name).toBe("My workspace (imported)");
		expect(copy.views[0]).toMatchObject({
			profileId: copy.profile.id, key: "tasks-sheet", preferences: bundle.views[0]!.preferences,
		});
		expect(copy.views[0]!.id).not.toBe("tasks");
		expect(copy.layouts[0]!.id).not.toBe("current");
		// Copying must leave the existing profile and its owned records intact.
		db.run("DELETE FROM workbench_profiles WHERE id = ?", [String(copy.profile.id)]);
		expect(savedState()).toEqual(original);
	});

	it("allows explicitly empty collections to replace saved views and layouts", async () => {
		const response = await request("/profiles/import", "POST", {
			bundle: { ...bundle, views: [], layouts: [] }, mode: "replace",
		});
		expect(response.status).toBe(201);
		const result = await response.json() as Omit<Bundle, "schemaVersion">;
		expect(result.views).toEqual([]);
		expect(result.layouts).toEqual([]);
		expect(result.profile.preferences).toEqual(bundle.profile.preferences);
	});
});
