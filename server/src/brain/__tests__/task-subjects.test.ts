import { describe, expect, it } from "bun:test";

import {
	buildCommitTaskSubject,
	buildValidationTaskSubject,
	buildVerificationTaskSubject,
	containsCommitTaskKeyword,
	isCommitTaskSubject,
	isFollowUpTaskSubject,
	isValidationTaskSubject,
	isVerificationTaskSubject,
} from "../task-subjects";

describe("task subjects", () => {
	it("builds canonical follow-up subjects", () => {
		expect(buildValidationTaskSubject("Implement endpoint")).toBe(
			"Validate completion: Implement endpoint",
		);
		expect(buildVerificationTaskSubject("Implement endpoint")).toBe(
			"Verify & Polish: Implement endpoint",
		);
		expect(buildCommitTaskSubject("Implement endpoint")).toBe(
			"Commit changes for: Implement endpoint",
		);
	});

	it("identifies follow-up task subjects consistently", () => {
		expect(isValidationTaskSubject("Validate completion: Implement endpoint")).toBe(true);
		expect(isVerificationTaskSubject("Verify & Polish: Implement endpoint")).toBe(true);
		expect(isCommitTaskSubject("Commit changes for: Implement endpoint")).toBe(true);
		expect(isFollowUpTaskSubject("Implement endpoint")).toBe(false);
	});

	it("recognizes commit work embedded in non-canonical subjects", () => {
		expect(containsCommitTaskKeyword("Retry commit changes for API cleanup")).toBe(
			true,
		);
		expect(containsCommitTaskKeyword("Implement endpoint")).toBe(false);
	});
});
