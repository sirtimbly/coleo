import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../db";
import { createTestEventStore } from "../../nats/in-memory-event-store";
import { resourceReference } from "../../workbench/resource-reference";
import { writeThreadFixture } from "../../scripts/workbench-demo/thread-fixture-api";
import { resolveMessagingReference } from "../messaging-reference";
import { loadMailThreadMailboxProjections } from "../mail-thread-projection";

import type { Database } from "bun:sqlite";

describe("filter-independent Messaging references", () => {
	let db: Database, directory: string;
	beforeEach(async () => { db = await initDatabase(":memory:"); directory = await mkdtemp(join(tmpdir(), "coleo-references-")); await writeThreadFixture(directory); });
	afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
	it("resolves retained events and records after they leave the attention view", async () => {
		const time = "2026-10-01T12:00:00Z";
		db.run("INSERT INTO tasks (id,subject,description,status,priority,source_type,created_at,updated_at) VALUES ('done','Done','body','completed','normal','manual',?,?)", [time, time]);
		const store = createTestEventStore();
		await store.publishEvent("coleo.events.brain.activity", { type: "poll_completed", timestamp: time, data: { actor: "brain", activityId: "older-poll" } });
		expect(await resolveMessagingReference(db, directory, resourceReference("task:done"), "local", { store })).toMatchObject({ id: "task:done", detail: { kind: "record", itemKey: "task:done" }, complete: true });
		expect(await resolveMessagingReference(db, directory, resourceReference("activity:older-poll"), "local", { store })).toMatchObject({ id: "activity:older-poll", detail: { kind: "activity", sequence: 1 }, complete: true });
	});
	it("distinguishes missing references from an incomplete lookup and validates identity/profile input", async () => {
		const store = createTestEventStore();
		await expect(resolveMessagingReference(db, directory, "@00000000", "local", { store })).rejects.toMatchObject({ status: 404 });
		await expect(resolveMessagingReference(db, directory, "@00000000", "local", { store,
			loadMail: async () => { throw new Error("offline"); } })).rejects.toMatchObject({ status: 503 });
		await expect(resolveMessagingReference(db, directory, "@not-a-ref", "local", { store })).rejects.toMatchObject({ status: 400 });
		await expect(resolveMessagingReference(db, directory, "@00000000", "missing", { store })).rejects.toMatchObject({ status: 404 });
	});
	it("bounds a stalled source and labels a successful healthy-source match as incomplete", async () => {
		const mail = await loadMailThreadMailboxProjections(directory);
		const result = await resolveMessagingReference(db, directory, resourceReference("thread:inbox:handoff"), "local", {
			store: { ...createTestEventStore(), isInitialized: () => false } as ReturnType<typeof createTestEventStore>,
			loadMail: async () => mail,
			timeoutMs: 10,
		});
		expect(result.id).toBe("thread:inbox:handoff");
		expect(result.complete).toBe(false);
		expect(result.diagnostics).toContain("Retained event reference source is unavailable");
		await expect(resolveMessagingReference(db, directory, "@00000000", "local", { store: createTestEventStore(), timeoutMs: 10,
			loadMail: async () => await new Promise(() => {}) })).rejects.toMatchObject({ status: 503 });
	});
});
