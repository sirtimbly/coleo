import { describe, expect, it } from "bun:test";
import { mapHarnessEventStatus } from "../server";

describe("mapHarnessEventStatus", () => {
	it("normalizes nested OpenCode session statuses", () => {
		expect(mapHarnessEventStatus("session.status", { status: { type: "idle" } })).toBe("idle");
		expect(mapHarnessEventStatus("session.status", { status: { type: "busy" } })).toBe("busy");
		expect(mapHarnessEventStatus("session.updated", { status: { type: "failed" } })).toBe("error");
	});
});
