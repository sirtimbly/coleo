import { describe, expect, it } from "bun:test";
import { InMemoryEventStore } from "../in-memory-event-store";

describe("InMemoryEventStore", () => {
	it("assigns stable sequences and returns the latest requested arm events", async () => {
		const store = new InMemoryEventStore();
		store.initialize();

		for (let index = 0; index < 5; index++) {
			await store.publishEvent("coleo.events.arm.arm-1.message.updated", {
				type: "message.updated",
				armId: "arm-1",
				data: { index },
				timestamp: new Date(1_000 + index).toISOString(),
			});
		}

		const events = await store.getArmEvents("arm-1", 2);

		expect(events.map((event) => event.sequence)).toEqual([4, 5]);
		expect(events.map((event) => event.data.index)).toEqual([3, 4]);
	});
});
