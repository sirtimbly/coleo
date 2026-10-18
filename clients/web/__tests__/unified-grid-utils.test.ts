import { describe, expect, it } from "bun:test";
import {
	filterDiscoveriesBySearch,
	filterTasksBySearch,
} from "../src/components/unified-grid-utils";

describe("unified grid search filters", () => {
	it("returns tasks unchanged for blank or whitespace search", () => {
		const tasks = [
			{ subject: "Alpha", description: "desc", phase: "Phase 1" },
			{ subject: "Beta", description: "other", phase: null },
		];
		expect(filterTasksBySearch(tasks, "")).toBe(tasks);
		expect(filterTasksBySearch(tasks, "   ")).toBe(tasks);
	});

	it("matches tasks by subject, description, and phase case-insensitively", () => {
		const tasks = [
			{ subject: "Add login", description: "passkey support", phase: "Phase 2: Core" },
			{ subject: "Fix CSV export", description: "broken pagination", phase: "Phase 5" },
		];
		expect(filterTasksBySearch(tasks, "LOGIN")).toHaveLength(1);
		expect(filterTasksBySearch(tasks, "passkey")[0]!.subject).toBe("Add login");
		expect(filterTasksBySearch(tasks, "phase 5")[0]!.subject).toBe("Fix CSV export");
		expect(filterTasksBySearch(tasks, "nothing-matches")).toHaveLength(0);
	});

	it("tolerates tasks without a phase", () => {
		const tasks = [{ subject: "Standalone item", description: "x", phase: null as string | null }];
		expect(filterTasksBySearch(tasks, "phase 9")).toHaveLength(0);
		expect(filterTasksBySearch(tasks, "standalone")).toHaveLength(1);
	});

	it("matches discoveries by title and details", () => {
		const discoveries = [
			{ title: "FTS5 untested", details: "no MATCH assertion exists" },
			{ title: "Garden perf", details: "no virtual scrolling" },
		];
		expect(filterDiscoveriesBySearch(discoveries, "fts5")).toHaveLength(1);
		expect(filterDiscoveriesBySearch(discoveries, "VIRTUAL")[0]!.title).toBe("Garden perf");
		expect(filterDiscoveriesBySearch(discoveries, "")).toBe(discoveries);
		expect(filterDiscoveriesBySearch(discoveries, "zzz")).toHaveLength(0);
	});
});
