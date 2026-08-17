import { describe, expect, it } from "bun:test";

import {
	filterSetupFilePaths,
	isSetupFileScope,
	setupPathMatchesScope,
} from "../src/pages/setup-file-scope";

const CANONICAL_PLAN_PATH = ".project/plan.md";
const PROJECT_PATHS = [
	CANONICAL_PLAN_PATH,
	".project/requirements.md",
	".coleo/config.toml",
	".coleo/arms/default.toml",
	".coleo-old/not-config.toml",
	"src/index.ts",
];

describe("Plan and Documents file scopes", () => {
	it("shows only the canonical plan in Plan scope", () => {
		expect(filterSetupFilePaths(PROJECT_PATHS, "plan", CANONICAL_PLAN_PATH)).toEqual([
			CANONICAL_PLAN_PATH,
		]);
		expect(filterSetupFilePaths([], "plan", CANONICAL_PLAN_PATH)).toEqual([
			CANONICAL_PLAN_PATH,
		]);
	});

	it("matches only the real .coleo directory in Coleo scope", () => {
		expect(filterSetupFilePaths(PROJECT_PATHS, "coleo", CANONICAL_PLAN_PATH)).toEqual([
			".coleo/config.toml",
			".coleo/arms/default.toml",
		]);
		expect(setupPathMatchesScope(".coleo", "coleo", CANONICAL_PLAN_PATH)).toBe(true);
		expect(setupPathMatchesScope(".coleo-old/file.toml", "coleo", CANONICAL_PLAN_PATH)).toBe(false);
	});

	it("keeps every path in All files scope and validates scope keys", () => {
		expect(filterSetupFilePaths(PROJECT_PATHS, "all", CANONICAL_PLAN_PATH)).toBe(PROJECT_PATHS);
		expect(isSetupFileScope("plan")).toBe(true);
		expect(isSetupFileScope("coleo")).toBe(true);
		expect(isSetupFileScope("all")).toBe(true);
		expect(isSetupFileScope("project")).toBe(false);
	});
});
