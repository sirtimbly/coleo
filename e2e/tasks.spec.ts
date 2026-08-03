/**
 * Browser protection for the editable Tasks sheet and its Golden Layout
 * detail handoff.
 */

/// <reference lib="dom" />

import { expect, test } from "@playwright/test";

import { installMockApi } from "./support/fixtures";

const task = {
	id: "task-workbench",
	subject: "Protect the critical workbench",
	description: "Add browser coverage for the spreadsheet and detail projection.",
	status: "pending",
	priority: "normal",
	sourceType: "manual",
	sourceRef: null,
	phase: "implementation",
	domain: "frontend",
	assignedTo: null,
	dueDate: null,
	artifacts: [],
	metadata: {},
	progress: 0,
	sortOrder: 1,
	createdAt: "2026-08-02T11:00:00.000Z",
	updatedAt: "2026-08-02T12:00:00.000Z",
	completedAt: null,
	claimedAt: null,
	startedAt: null,
};

const bug = {
	id: "bug-workbench",
	title: "Restore bug tags",
	description: "Keep tags and row formatting available in the shared sheet.",
	source: "human_reported",
	status: "open",
	priority: "high",
	blockers: [],
	metadata: {
		ui: {
			tags: ["regression", "ui"],
			color: "slate",
			bold: false,
		},
	},
	createdAt: "2026-08-02T11:00:00.000Z",
	updatedAt: "2026-08-02T12:00:00.000Z",
	humanNotified: false,
};

test("formats task rows and restores bug tags in configurable spreadsheets", async ({ page }) => {
	await installMockApi(page, { tasks: [task], bugs: [bug] });
	await page.goto("/tasks");

	await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
	await expect(page.getByText("Protect the critical workbench", { exact: true })).toBeVisible();
	await expect(page.getByText(/select a row to format/i)).toBeVisible({
		timeout: 20_000,
	});

	const rowHeader = page.getByRole("rowheader", { name: "1", exact: true });
	await expect(rowHeader).toHaveCount(1);
	const sampleGutterStates = () => rowHeader.evaluate(async (element) => {
		const classNames = new Set<string>();
		let bodyBackgroundMatches = 0;
		const startedAt = performance.now();
		do {
			const style = getComputedStyle(element);
			classNames.add(element.className);
			if (style.backgroundColor === getComputedStyle(document.body).backgroundColor) {
				bodyBackgroundMatches += 1;
			}
			await new Promise(requestAnimationFrame);
		} while (performance.now() - startedAt < 300);
		return { classNames: [...classNames], bodyBackgroundMatches };
	});
	const expectStableGutter = async () => {
		const state = await sampleGutterStates();
		expect(state.classNames).toHaveLength(1);
		expect(state.bodyBackgroundMatches).toBe(0);
	};

	await rowHeader.click();
	await expectStableGutter();
	const formattingToolbar = page.getByRole("toolbar", { name: "Format selected row" });
	await expect(formattingToolbar).toBeVisible();

	const taskSubjectCell = page
		.locator(".coleo-resource-sheet")
		.getByRole("gridcell", { name: "Protect the critical workbench", exact: true });
	await taskSubjectCell.click();
	await expectStableGutter();
	await formattingToolbar.getByRole("button", { name: "Bold", exact: true }).click();
	await expect(taskSubjectCell).toHaveClass(/coleo-sheet-row-bold/);
	await formattingToolbar
		.getByRole("button", { name: "Use blue row color", exact: true })
		.click();
	await expect(taskSubjectCell).toHaveClass(/coleo-sheet-row-color-blue/);

	await expect(
		page.locator(".coleo-resource-sheet .ht_clone_inline_start tbody td"),
	).toHaveCount(0);

	await page.goto("/bugs");
	await expect(page.getByRole("heading", { name: "Bugs", exact: true })).toBeVisible();
	await expect(page.getByRole("columnheader", { name: "Tags", exact: true })).toBeVisible({
		timeout: 20_000,
	});
	const bugSheet = page.locator(".coleo-resource-sheet");
	await expect(
		bugSheet.getByRole("gridcell", { name: "regression, ui", exact: true }),
	).toBeVisible();
	await page.getByRole("rowheader", { name: "1", exact: true }).click();
	await expect(formattingToolbar).toBeVisible();
	const bugSubjectCell = bugSheet.getByRole("gridcell", {
		name: "Restore bug tags",
		exact: true,
	});
	await formattingToolbar
		.getByRole("button", { name: "Use green row color", exact: true })
		.click();
	await expect(bugSubjectCell).toHaveClass(/coleo-sheet-row-color-emerald/);
});

test("opens a spreadsheet row in the dedicated task detail projection", async ({ page }) => {
	await installMockApi(page, { tasks: [task] });
	await page.goto("/tasks");
	const sheet = page.locator(".coleo-resource-sheet");
	await expect(sheet).toBeVisible({ timeout: 20_000 });
	await sheet.getByText("Protect the critical workbench", { exact: true }).dblclick();

	await expect(page).toHaveURL(/\/tasks\?.*task=task-workbench/);
	await expect(
		page.getByRole("heading", { name: "Protect the critical workbench", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("tab", { name: "Details" })).toBeVisible();
});
