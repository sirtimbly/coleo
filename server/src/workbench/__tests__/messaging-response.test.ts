import { describe, expect, it } from "bun:test";
import { validateMessagingResponseIdentity } from "../messaging-response";

describe("Messaging contract negotiation", () => {
	it("diagnoses the legacy envelope returned by an API process that has not reloaded", () => {
		expect(() => validateMessagingResponseIdentity({ items: [], nextCursor: undefined }, "current"))
			.toThrow("Restart the Coleo API server");
	});

	it("keeps wrong-query protection distinct from unsupported versions", () => {
		expect(() => validateMessagingResponseIdentity({ schemaVersion: 1, queryId: "previous" }, "current"))
			.toThrow("belongs to another query");
		expect(() => validateMessagingResponseIdentity({ schemaVersion: 2, queryId: "current" }, "current"))
			.toThrow("incompatible");
		expect(() => validateMessagingResponseIdentity({ schemaVersion: 1, queryId: "current" }, "current"))
			.not.toThrow();
	});
});
