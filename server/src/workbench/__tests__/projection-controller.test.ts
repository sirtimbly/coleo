import { describe, expect, it } from "bun:test";
import { ProjectionController } from "../projection-controller";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("bounded projection request ownership", () => {
	it("shares one in-flight load and queues one trailing fetch for a continuous burst", async () => {
		let calls = 0, active = 0, maximum = 0;
		const controller = new ProjectionController(async () => {
			calls++; maximum = Math.max(maximum, ++active); await wait(25); active--; return calls;
		}, 10);
		const off = controller.subscribe(() => {});
		const off2 = controller.subscribe(() => {});
		await wait(5);
		for (let i = 0; i < 15; i++) controller.schedule();
		await wait(80);
		expect(maximum).toBe(1);
		expect(calls).toBe(2);
		expect(controller.getSnapshot().value).toBe(2);
		off(); off2(); controller.dispose();
	});

	it("does not postpone refresh forever under events faster than the scheduling interval", async () => {
		let calls = 0;
		const controller = new ProjectionController(async () => ++calls, 20);
		await controller.refresh();
		const burst = setInterval(() => controller.schedule(), 3);
		await wait(80); clearInterval(burst);
		expect(calls).toBeGreaterThan(2);
		controller.dispose();
	});

	it("keeps previous data on failure and waits for the queued refresh requested by a successful action", async () => {
		let calls = 0;
		const controller = new ProjectionController(async () => { calls++; await wait(15); if (calls === 2) throw new Error("Unavailable"); return calls; });
		await controller.refresh();
		const second = controller.refresh();
		const trailing = controller.refresh();
		await second;
		expect(controller.getSnapshot().value).toBe(1);
		await trailing;
		expect(controller.getSnapshot().value).toBe(3);
		controller.dispose();
	});

	it("a disposed query cannot publish a late response into another query", async () => {
		const old = new ProjectionController(async () => { await wait(20); return "old"; });
		const next = new ProjectionController(async () => "new");
		void old.refresh(); old.dispose(); await next.refresh(); await wait(30);
		expect(next.getSnapshot().value).toBe("new");
		expect(old.getSnapshot().value).toBeUndefined();
		next.dispose();
	});

	it("coalesces intermediate mutation hints into one awaited post-mutation refresh", async () => {
		let calls = 0;
		const controller = new ProjectionController(async () => ++calls, 5);
		await controller.refresh();
		const finish = controller.beginMutation();
		for (let i = 0; i < 50; i++) controller.schedule();
		await wait(20);
		expect(calls).toBe(1);
		expect(controller.getSnapshot().loading).toBe(false);
		await finish();
		expect(calls).toBe(2);
		expect(controller.getSnapshot().value).toBe(2);
		await finish();
		expect(calls).toBe(2);
		controller.dispose();
	});

	for (const outcome of ["value", "error"] as const) {
		it(`does not publish a pre-mutation ${outcome}, even if cancellation is ignored`, async () => {
			let calls = 0;
			let resolve!: (value: string) => void;
			let reject!: (error: Error) => void;
			const old = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
			const controller = new ProjectionController(async () => ++calls === 1 ? old : "confirmed");
			const initial = controller.refresh();
			const finish = controller.beginMutation();
			if (outcome === "value") resolve("intermediate"); else reject(new Error("Mail files moved"));
			await initial;
			expect(controller.getSnapshot()).toMatchObject({ value: undefined, loading: false, error: null });
			await finish();
			expect(controller.getSnapshot()).toMatchObject({ value: "confirmed", loading: false, error: null });
			expect(calls).toBe(2);
			controller.dispose();
		});
	}

	it("releases overlapping writes with one refresh and resolves both completion promises", async () => {
		let calls = 0;
		const controller = new ProjectionController(async () => ++calls, 5);
		await controller.refresh();
		const first = controller.beginMutation(), second = controller.beginMutation();
		const waiting = first();
		controller.schedule();
		expect(calls).toBe(1);
		await second(); await waiting;
		expect(calls).toBe(2);
		controller.dispose();
	});
});
