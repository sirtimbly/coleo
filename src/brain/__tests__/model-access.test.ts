import { describe, expect, it } from "bun:test";

import {
	BrainModelAccessError,
	detectBrainModelAccessIssue,
	getBrainModelAccessIssue,
	parseBrainModelAccessIssue,
	serializeBrainModelAccessIssue,
} from "../model-access";

describe("Brain model access errors", () => {
	it("recognizes OpenAI insufficient-credit responses without treating ordinary rate limits as billing failures", () => {
		const issue = detectBrainModelAccessIssue(
			429,
			JSON.stringify({
				error: {
					message: "You have no credits remaining. Add credits to continue using the API.",
					type: "insufficient_quota",
				},
			}),
			"openai",
		);

		expect(issue).toMatchObject({
			code: "insufficient_credits",
			provider: "openai",
			actionLabel: "Add OpenAI API credits",
		});
		expect(issue?.actionUrl).toContain("platform.openai.com");
		expect(
			detectBrainModelAccessIssue(
				429,
				'{"error":{"message":"Rate limit reached for requests per minute"}}',
				"openai",
			),
		).toBeNull();
	});

	it("round-trips persisted issues and preserves the structured error", () => {
		const issue = detectBrainModelAccessIssue(
			429,
			'{"error":{"message":"insufficient_quota"}}',
			"openai",
		);
		expect(issue).not.toBeNull();
		if (!issue) return;

		expect(parseBrainModelAccessIssue(serializeBrainModelAccessIssue(issue))).toEqual(issue);
		expect(getBrainModelAccessIssue(new BrainModelAccessError(issue))).toEqual(issue);
		expect(parseBrainModelAccessIssue("insufficient_credits")).toBeNull();
	});
});
