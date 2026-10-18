import { describe, expect, it } from "bun:test";

import {
	normalizeTagValues,
	resourceTagValidationError,
} from "../src/workbench/tag-values";

describe("resource tag validation", () => {
	it("accepts only non-empty ASCII alphanumeric tags", () => {
		expect(resourceTagValidationError("Release2026")).toBeUndefined();
		expect(resourceTagValidationError("release,2026")).toBeDefined();
		expect(resourceTagValidationError("release-2026")).toBeDefined();
		expect(resourceTagValidationError("école")).toBeDefined();
		expect(resourceTagValidationError("")).toBeDefined();
	});

	it("drops invalid pasted or legacy tag values", () => {
		expect(normalizeTagValues([
			"Release2026",
			"release,2026",
			"alpha beta",
			"Backend",
			"Backend",
		])).toEqual(["Release2026", "Backend"]);
	});
});
