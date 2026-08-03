/**
 * Contract tests for the data boundary of the Tabulator Tasks migration spike.
 *
 * These tests keep renderer-specific callbacks from silently changing Coleo's
 * existing edit and reorder payloads while the two grid implementations coexist.
 */

import { describe, expect, it } from "bun:test";

import {
	createTabulatorTaskUpdate,
	resolveTabulatorTaskMove,
	toTabulatorTaskRows,
} from "../src/workbench/tabulator-task-model";

import type { Task } from "../src/lib";

function task(id: string, subject: string, sortOrder: number): Task {
	return {
		id,
		subject,
		description: subject,
		status: "pending",
		priority: "normal",
		sourceType: "manual",
		sourceRef: null,
		phase: "implementation",
		classification: null,
		domain: "frontend",
		assignedTo: null,
		sortOrder,
		progress: 25,
		createdAt: "2026-08-03T10:00:00.000Z",
		updatedAt: "2026-08-03T11:00:00.000Z",
		completedAt: null,
		claimedAt: null,
		startedAt: null,
		dueDate: null,
		artifacts: [],
		metadata: {
			ui: {
				bold: id === "task-a",
				color: id === "task-a" ? "blue" : "slate",
			},
		},
	};
}

describe("tabulator task model", () => {
	it("projects API tasks into stable grid rows", () => {
		const [row] = toTabulatorTaskRows([task("task-a", "First task", 0)]);

		expect(row).toMatchObject({
			id: "task-a",
			subject: "First task",
			status: "pending",
			phase: "implementation",
			domain: "frontend",
			progress: 25,
			bold: true,
			color: "blue",
		});
	});

	it("accepts only supported inline edits", () => {
		expect(createTabulatorTaskUpdate("subject", "  Updated subject  ")).toEqual({
			subject: "Updated subject",
		});
		expect(createTabulatorTaskUpdate("status", "in_progress")).toEqual({
			status: "in_progress",
		});
		expect(createTabulatorTaskUpdate("subject", "   ")).toBeUndefined();
		expect(createTabulatorTaskUpdate("status", "invented")).toBeUndefined();
		expect(createTabulatorTaskUpdate("priority", "high")).toBeUndefined();
	});

	it("translates a rendered row order into the existing reorder contract", () => {
		const tasks = [
			task("task-a", "First", 0),
			task("task-b", "Second", 1),
			task("task-c", "Third", 2),
		];

		expect(
			resolveTabulatorTaskMove(
				tasks,
				"task-a",
				0,
				["task-b", "task-c", "task-a"],
			),
		).toEqual({
			row: tasks[0],
			fromIndex: 0,
			toIndex: 2,
			previousRow: tasks[2],
			nextRow: undefined,
		});
		expect(
			resolveTabulatorTaskMove(tasks, "task-b", 1, ["task-a", "task-b", "task-c"]),
		).toBeUndefined();
	});
});
