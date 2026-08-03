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

const discovery = {
	id: "discovery-workbench",
	armId: "arm-undo",
	armName: "Undo Arm",
	kind: "pattern",
	title: "Keep sheet history consistent",
	details: "Discovery status must share the same undo and redo behavior.",
	filePath: null,
	lineNumber: null,
	severity: "info",
	status: "open",
	createdAt: "2026-08-02T11:00:00.000Z",
	updatedAt: "2026-08-02T12:00:00.000Z",
};

test("formats rows and preserves undo and redo across resource sheets", async ({ page }) => {
	await installMockApi(page, {
		tasks: [task],
		bugs: [bug],
		discoveries: [discovery],
	});
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
	await expect(taskSubjectCell).toHaveCSS("font-weight", "400");
	await formattingToolbar.getByRole("button", { name: "Bold", exact: true }).click();
	await expect(taskSubjectCell).toHaveClass(/coleo-sheet-row-bold/);
	await expect(taskSubjectCell).toHaveCSS("font-weight", "700");
	await formattingToolbar
		.getByRole("button", { name: "Use blue row color", exact: true })
		.click();
	await expect(taskSubjectCell).toHaveClass(/coleo-sheet-row-color-blue/);

	await expect(
		page.locator(".coleo-resource-sheet .ht_clone_inline_start tbody td"),
	).toHaveCount(0);

	const editedSubject = "Undo and redo the task subject";
	const editRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/tasks/task-workbench"
	);
	await taskSubjectCell.click();
	await page.keyboard.press("Enter");
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.type(editedSubject);
	await page.keyboard.press("Enter");
	expect((await editRequest).postDataJSON()).toMatchObject({ subject: editedSubject });
	await expect(
		page.getByRole("gridcell", { name: editedSubject, exact: true }),
	).toBeVisible();

	const undoRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/tasks/task-workbench"
	);
	await page.keyboard.press("ControlOrMeta+Z");
	expect((await undoRequest).postDataJSON()).toMatchObject({
		subject: task.subject,
	});
	await expect(
		page.getByRole("gridcell", { name: task.subject, exact: true }),
	).toBeVisible();

	const redoRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/tasks/task-workbench"
	);
	await page.keyboard.press("ControlOrMeta+Shift+Z");
	expect((await redoRequest).postDataJSON()).toMatchObject({ subject: editedSubject });
	await expect(
		page.getByRole("gridcell", { name: editedSubject, exact: true }),
	).toBeVisible();

	await page.goto("/bugs");
	await expect(page.getByRole("heading", { name: "Bugs", exact: true })).toBeVisible();
	await expect(page.getByRole("columnheader", { name: "Tags", exact: true })).toBeVisible({
		timeout: 20_000,
	});
	const bugSheet = page.locator(".coleo-resource-sheet");
	const tagsCell = bugSheet.locator("td.ht-multi-select-renderer").filter({
		hasText: "regression",
	});
	const tagChips = tagsCell.locator(".ht-multi-select-chip-label");
	await expect(tagChips).toHaveText(["regression", "ui"]);

	// Open the editor from the empty side of the cell so the gesture doesn't
	// target either chip's remove control.
	await tagsCell.dblclick({ position: { x: 174, y: 14 } });
	const tagsEditor = bugSheet.locator(".ht-multi-select-editor");
	await expect(tagsEditor).toBeVisible();
	await expect(tagsEditor.getByRole("checkbox", { name: "regression" })).toBeChecked();
	await expect(tagsEditor.getByRole("checkbox", { name: "ui" })).toBeChecked();
	const tagUpdateRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/bugs/bug-workbench"
	);
	await tagsEditor.getByRole("checkbox", { name: "ui" }).uncheck();
	const requestBody = (await tagUpdateRequest).postDataJSON() as {
		metadata?: { ui?: { tags?: string[] } };
	};
	expect(requestBody.metadata?.ui?.tags).toEqual(["regression"]);
	await expect(tagChips).toHaveText(["regression"]);

	await page.keyboard.press("Escape");
	await tagsCell.click({ position: { x: 174, y: 14 } });
	const undoTagsRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/bugs/bug-workbench"
	);
	await page.keyboard.press("ControlOrMeta+Z");
	const undoTagsBody = (await undoTagsRequest).postDataJSON() as {
		metadata?: { ui?: { tags?: string[] } };
	};
	expect(undoTagsBody.metadata?.ui?.tags).toEqual(["regression", "ui"]);
	await expect(tagChips).toHaveText(["regression", "ui"]);

	const redoTagsRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/bugs/bug-workbench"
	);
	await page.keyboard.press("ControlOrMeta+Shift+Z");
	const redoTagsBody = (await redoTagsRequest).postDataJSON() as {
		metadata?: { ui?: { tags?: string[] } };
	};
	expect(redoTagsBody.metadata?.ui?.tags).toEqual(["regression"]);
	await expect(tagChips).toHaveText(["regression"]);

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

	await page.goto("/grid");
	await expect(
		page.getByRole("heading", { name: "Resource sheets", exact: true }),
	).toBeVisible();
	await page.getByRole("tab", { name: /Discoveries/ }).click();
	const discoverySheet = page.locator(".coleo-resource-sheet");
	const discoveryStatusCell = discoverySheet.getByRole("gridcell", {
		name: "open",
		exact: true,
	});
	await expect(discoveryStatusCell).toBeVisible({ timeout: 20_000 });

	await discoveryStatusCell.click();
	await page.keyboard.press("Enter");
	const discoveryStatusUpdate = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/discoveries/discovery-workbench"
	);
	await page
		.locator(".handsontable.listbox")
		.getByText("acknowledged", { exact: true })
		.click();
	expect((await discoveryStatusUpdate).postDataJSON()).toEqual({
		status: "acknowledged",
	});
	const acknowledgedStatusCell = discoverySheet.getByRole("gridcell", {
		name: "acknowledged",
		exact: true,
	});
	await expect(acknowledgedStatusCell).toBeVisible();

	const undoDiscoveryRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/discoveries/discovery-workbench"
	);
	await acknowledgedStatusCell.click({ button: "right" });
	const contextMenu = page.locator(".htContextMenu");
	await expect(contextMenu.getByText("Undo", { exact: true })).toBeVisible();
	await expect(contextMenu.getByText("Redo", { exact: true })).toBeVisible();
	await contextMenu.getByText("Undo", { exact: true }).click();
	expect((await undoDiscoveryRequest).postDataJSON()).toEqual({ status: "open" });
	await expect(discoveryStatusCell).toBeVisible();

	const redoDiscoveryRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/discoveries/discovery-workbench"
	);
	await discoveryStatusCell.click({ button: "right" });
	await contextMenu.getByText("Redo", { exact: true }).click();
	expect((await redoDiscoveryRequest).postDataJSON()).toEqual({
		status: "acknowledged",
	});
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
