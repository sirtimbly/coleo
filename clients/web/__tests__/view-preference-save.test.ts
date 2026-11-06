import { describe, expect, it } from "bun:test";
import { ViewPreferenceSave } from "../src/workbench/view-preference-save";
import type { ViewDefinition } from "../src/workbench/types";

function view(profileId = "local"): ViewDefinition {
	return { id: `view:${profileId}:tasks`, profileId, key: "tasks", name: "Tasks", kind: "sheet",
		query: {}, preferences: { density: "compact" }, shared: false, version: 1,
		createdAt: "2026-11-05", updatedAt: "2026-11-05" };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function writeAt(writes: readonly ViewDefinition[], index: number): ViewDefinition {
	const write = writes[index];
	if (write === undefined) throw new Error(`Expected preference write ${index + 1}`);
	return write;
}

describe("view preference persistence", () => {
	it("debounces rapid edits into the latest payload", async () => {
		const saved = deferred<ViewDefinition>();
		const writes: ViewDefinition[] = [];
		const session = new ViewPreferenceSave(view(), async (next) => {
			writes.push(next);
			saved.resolve(next);
			return next;
		}, 10);
		const stop = session.subscribe(() => {});
		session.updatePreferences({ gridFontSize: 12 });
		session.updatePreferences({ gridFontSize: 14 });
		session.updatePreferences({ gridFontSize: 18 });
		expect((await saved.promise).preferences.gridFontSize).toBe(18);
		expect(writes).toHaveLength(1);
		stop();
	});

	it("serializes delayed saves and retains edits and sharing changes made during a request", async () => {
		const first = deferred<ViewDefinition>();
		const writes: ViewDefinition[] = [];
		const session = new ViewPreferenceSave(view(), async (next) => {
			writes.push(next);
			return writes.length === 1 ? first.promise : { ...next, version: 3 };
		});
		const stop = session.subscribe(() => {});
		session.updatePreferences({ density: "comfortable" });
		const pending = session.flush();
		session.updatePreferences({ density: "compact", gridFontSize: 16 });
		session.updateShared(true);
		await session.flush();
		expect(writes).toHaveLength(1);
		first.resolve({ ...writeAt(writes, 0), version: 2 });
		await pending;
		expect(session.getSnapshot().dirty).toBe(true);
		expect(session.getSnapshot().view.preferences).toEqual({ density: "compact", gridFontSize: 16 });
		expect(session.getSnapshot().lastConfirmed.preferences.density).toBe("comfortable");
		session.confirm(view());
		await session.flush();
		expect(writeAt(writes, 1).shared).toBe(true);
		expect(writeAt(writes, 1).preferences.gridFontSize).toBe(16);
		expect(session.getSnapshot().dirty).toBe(false);
		expect(session.getSnapshot().lastConfirmed.version).toBe(3);
		stop();
	});

	it("handles rejection, preserves the confirmed state, and retries the latest edits", async () => {
		const request = deferred<ViewDefinition>();
		const writes: ViewDefinition[] = [];
		const initial = view();
		const session = new ViewPreferenceSave(initial, async (next) => {
			writes.push(next);
			return writes.length === 1 ? request.promise : next;
		});
		const stop = session.subscribe(() => {});
		session.updateShared(true);
		const pending = session.flush();
		session.updatePreferences({ density: "comfortable" });
		request.reject(new Error("Offline"));
		await pending; // This must resolve, including for fire-and-forget callers.
		expect(session.getSnapshot().error?.message).toBe("Offline");
		expect(session.getSnapshot().lastConfirmed).toBe(initial);
		expect(session.getSnapshot().dirty).toBe(true);
		session.updateShared(false);
		await session.flush();
		expect(writeAt(writes, 1).shared).toBe(false);
		expect(writeAt(writes, 1).preferences.density).toBe("comfortable");
		expect(session.getSnapshot().error).toBeNull();
		expect(session.getSnapshot().dirty).toBe(false);
		stop();
	});

	it("does not send queued edits from a departed profile or notify its new consumer", async () => {
		const oldRequest = deferred<ViewDefinition>();
		const writes: ViewDefinition[] = [];
		const old = new ViewPreferenceSave(view(), async (next) => { writes.push(next); return oldRequest.promise; }, 0);
		const leave = old.subscribe(() => {});
		old.updateShared(true);
		const pending = old.flush();
		old.updatePreferences({ density: "comfortable" });
		leave();
		const active = new ViewPreferenceSave(view("reviewer"), async (next) => { writes.push(next); return next; });
		const stop = active.subscribe(() => {});
		active.updatePreferences({ gridFontSize: 18 });
		await active.flush();
		oldRequest.resolve(writeAt(writes, 0));
		await pending;
		await old.flush();
		expect(writes.map((item) => item.profileId)).toEqual(["local", "reviewer"]);
		expect(active.getSnapshot().lastConfirmed.preferences).toEqual({ gridFontSize: 18 });
		expect(active.getSnapshot().error).toBeNull();
		stop();
	});
});
