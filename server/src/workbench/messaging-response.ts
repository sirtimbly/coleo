/** Distinguish an API/client contract mismatch from an obsolete response to a different query. */
export function validateMessagingResponseIdentity(response: unknown, expectedQueryId: string): void {
	if (typeof response !== "object" || response === null || !("schemaVersion" in response) || response.schemaVersion !== 1) {
		throw new Error("The Messaging API is out of date or incompatible. Restart the Coleo API server, then refresh this view.");
	}
	if (!("queryId" in response) || response.queryId !== expectedQueryId) {
		throw new Error("Messaging response belongs to another query");
	}
}
