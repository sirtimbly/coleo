/**
 * Browser protection for the editable Tasks sheet and its Golden Layout
 * detail handoff.
 */

/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from "@playwright/test";

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

const secondTask = {
	...task,
	id: "task-second",
	subject: "Keep manual ordering predictable",
	sortOrder: 2,
};

const draftTask = {
	...task,
	id: "task-draft",
	subject: "Shape a future task",
	status: "draft",
	sortOrder: 3,
};

const secondBug = {
	...bug,
	id: "bug-second",
	title: "Verify the reorder handle",
	sortOrder: 2,
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

async function dragTabulatorRowAfter(page: Page, source: Locator, target: Locator) {
	await expect(source).toBeVisible({ timeout: 20_000 });
	await expect(target).toBeVisible({ timeout: 20_000 });
	const sourceBox = await source.boundingBox();
	const targetBox = await target.boundingBox();
	if (!sourceBox || !targetBox) throw new Error("Tabulator rows are not visible");
	await page.mouse.move(sourceBox.x + sourceBox.width * 0.72, sourceBox.y + sourceBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		targetBox.x + targetBox.width * 0.72,
		targetBox.y + targetBox.height - 2,
		{ steps: 10 },
	);
	await page.mouse.up();
}

test("formats rows and preserves undo and redo across resource sheets", async ({ page }) => {
	await installMockApi(page, {
		tasks: [task],
		bugs: [bug],
		discoveries: [discovery],
	});
	await page.addInitScript(() => {
		window.localStorage.setItem("coleo-theme", "dark");
	});
	await page.goto("/tasks");

	await expect(
		page.getByRole("searchbox", { name: "Search tasks", exact: true }),
	).toBeVisible();
	const activityToggle = page.getByRole("button", { name: "Activity", exact: true });
	await expect(page.getByRole("button", { name: "Burndown", exact: true })).toBeVisible();
	await expect(activityToggle).toBeVisible();
	await activityToggle.click();
	await expect(
		page.getByRole("region", { name: "Task Activity", exact: true }),
	).toBeVisible();
	await activityToggle.click();
	await expect(
		page.getByRole("region", { name: "Task Activity", exact: true }),
	).toHaveCount(0);
	const resourceSheet = page.locator(".coleo-resource-sheet");
	await expect(resourceSheet).toBeVisible({ timeout: 20_000 });
	const taskSubjectCell = resourceSheet
		.locator('.tabulator-row[data-resource-id="task-workbench"]')
		.locator('.tabulator-cell[tabulator-field="subject"]');
	await expect(taskSubjectCell).toContainText(task.subject);
	expect(await resourceSheet.evaluate((element) => element.clientHeight)).toBeGreaterThan(500);

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

	await taskSubjectCell.click();
	await expectStableGutter();
	const activeHeaderBackgrounds = await resourceSheet
		.locator(".tabulator-header .tabulator-col")
		.evaluateAll((headers) => headers.map((header) => getComputedStyle(header).backgroundColor));
	expect(activeHeaderBackgrounds.length).toBeGreaterThan(0);
	expect(activeHeaderBackgrounds).not.toContain("rgb(255, 255, 255)");
	await expect(taskSubjectCell).toHaveCSS("font-weight", "400");
	await formattingToolbar.getByRole("button", { name: "Bold", exact: true }).click();
	await expect(taskSubjectCell).toHaveClass(/coleo-sheet-row-bold/);
	await expect(taskSubjectCell).toHaveCSS("font-weight", "700");
	await rowHeader.click();
	await expect(formattingToolbar).toBeVisible();
	await formattingToolbar
		.getByRole("button", { name: "Use blue row color", exact: true })
		.click();
	await expect(taskSubjectCell).toHaveClass(/coleo-sheet-row-color-blue/);

	await expect(page.locator(".handsontable")).toHaveCount(0);

	const editedSubject = "Undo and redo the task subject";
	const editRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/tasks/task-workbench"
	);
	await taskSubjectCell.dblclick();
	const subjectEditor = taskSubjectCell.locator("input");
	await expect(subjectEditor).toBeVisible();
	const editorUsesThemeTokens = await subjectEditor.evaluate((element) => {
		const probe = document.createElement("span");
		probe.style.color = "var(--foreground)";
		probe.style.backgroundColor = "var(--surface-secondary)";
		document.body.append(probe);
		const editorStyle = getComputedStyle(element);
		const probeStyle = getComputedStyle(probe);
		const matches = {
			foreground: editorStyle.color === probeStyle.color,
			background: editorStyle.backgroundColor === probeStyle.backgroundColor,
		};
		probe.remove();
		return matches;
	});
	expect(editorUsesThemeTokens).toEqual({ foreground: true, background: true });
	await subjectEditor.fill(editedSubject);
	await page.keyboard.press("Enter");
	expect((await editRequest).postDataJSON()).toMatchObject({ subject: editedSubject });
	await expect(taskSubjectCell).toContainText(editedSubject);

	const undoRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/tasks/task-workbench"
	);
	await rowHeader.click();
	await page.keyboard.press("ControlOrMeta+Z");
	expect((await undoRequest).postDataJSON()).toMatchObject({
		subject: task.subject,
	});
	await expect(taskSubjectCell).toContainText(task.subject);

	const redoRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/tasks/task-workbench"
	);
	await rowHeader.click();
	await page.keyboard.press("ControlOrMeta+Shift+Z");
	expect((await redoRequest).postDataJSON()).toMatchObject({ subject: editedSubject });
	await expect(taskSubjectCell).toContainText(editedSubject);

	await page.goto("/bugs");
	await expect(
		page.getByRole("searchbox", { name: "Search bugs", exact: true }),
	).toBeVisible();
	const bugActivityToggle = page.getByRole("button", { name: "Activity", exact: true });
	await expect(page.getByRole("button", { name: "Burndown", exact: true })).toBeVisible();
	await bugActivityToggle.click();
	await expect(page.getByRole("region", { name: "Bug Activity", exact: true })).toBeVisible();
	await expect(page.getByText("Recently Reported", { exact: true })).toBeVisible();
	await bugActivityToggle.click();
	await expect(page.getByRole("region", { name: "Bug Activity", exact: true })).toHaveCount(0);
	await expect(page.getByRole("columnheader", { name: "Tags", exact: true })).toBeVisible({
		timeout: 20_000,
	});
	const bugSheet = page.locator(".coleo-resource-sheet");
	expect(await bugSheet.evaluate((element) => element.clientHeight)).toBeGreaterThan(500);
	const tagsCell = bugSheet.locator('.tabulator-cell[tabulator-field="tags"]');
	const tagChips = tagsCell.locator(".coleo-tabulator-tag");
	await expect(tagChips).toHaveText(["regression", "ui"]);

	// Open the editor from the empty side of the cell so the gesture doesn't
	// target either chip's remove control.
	await tagsCell.dblclick();
	const tagsEditor = page.locator(".coleo-tabulator-multiselect-editor");
	await expect(tagsEditor).toBeVisible();
	await expect(tagsEditor.getByRole("checkbox", { name: "regression" })).toBeChecked();
	await expect(tagsEditor.getByRole("checkbox", { name: "ui" })).toBeChecked();
	const tagUpdateRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/bugs/bug-workbench"
	);
	await tagsEditor.getByRole("checkbox", { name: "ui" }).uncheck();
	await tagsEditor.getByRole("button", { name: "Apply", exact: true }).click();
	const requestBody = (await tagUpdateRequest).postDataJSON() as {
		metadata?: { ui?: { tags?: string[] } };
	};
	expect(requestBody.metadata?.ui?.tags).toEqual(["regression"]);
	await expect(tagChips).toHaveText(["regression"]);

	await bugSheet.focus();
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

	const bugSubjectCell = bugSheet
		.locator('.tabulator-row[data-resource-id="bug-workbench"]')
		.locator('.tabulator-cell[tabulator-field="title"]');
	await bugSubjectCell.click();
	await expect(formattingToolbar).toBeVisible();
	await formattingToolbar
		.getByRole("button", { name: "Use green row color", exact: true })
		.click();
	await expect(bugSubjectCell).toHaveClass(/coleo-sheet-row-color-green/);
	await bugSheet
		.getByRole("gridcell", { name: "human_reported", exact: true })
		.dblclick();
	await expect(page).toHaveURL(/\/bugs\?.*bug=bug-workbench/);
	await expect(
		page.getByRole("heading", { name: "Restore bug tags", exact: true }),
	).toBeVisible();

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

	await discoveryStatusCell.dblclick();
	const discoveryStatusUpdate = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/discoveries/discovery-workbench"
	);
	await page
		.locator(".tabulator-edit-list")
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
	const contextMenu = page.locator(".tabulator-menu");
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

test("matches sheet status colors to the burndown legend", async ({ page }) => {
	await installMockApi(page, { tasks: [task], bugs: [bug] });
	await page.goto("/tasks");

	const taskSheet = page.locator(".coleo-resource-sheet");
	const pendingStatus = taskSheet.getByRole("gridcell", {
		name: "Pending status",
		exact: true,
	});
	await expect(pendingStatus).toBeVisible({ timeout: 20_000 });
	await expect(pendingStatus).toHaveCSS("color", "rgb(148, 163, 184)");

	const statusUpdate = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/tasks/task-workbench"
	);
	await pendingStatus.dblclick();
	await page
		.locator(".tabulator-edit-list")
		.getByText("completed", { exact: true })
		.click();
	expect((await statusUpdate).postDataJSON()).toMatchObject({ status: "completed" });
	await expect(
		taskSheet.getByRole("gridcell", { name: "Completed status", exact: true }),
	).toHaveCSS("color", "rgb(34, 197, 94)");

	await page.goto("/bugs");
	const openStatus = page.locator(".coleo-resource-sheet").getByRole("gridcell", {
		name: "Open status",
		exact: true,
	});
	await expect(openStatus).toBeVisible({ timeout: 20_000 });
	await expect(openStatus).toHaveCSS("color", "rgb(239, 68, 68)");
});

test("opens a spreadsheet row from the Details context action", async ({ page }) => {
	await installMockApi(page, { tasks: [task] });
	await page.goto("/tasks");
	const sheet = page.locator(".coleo-resource-sheet");
	await expect(sheet).toBeVisible({ timeout: 20_000 });
	await sheet
		.getByRole("gridcell", { name: "implementation", exact: true })
		.click({ button: "right" });
	const contextMenu = page.locator(".tabulator-menu");
	await expect(contextMenu.getByText("Details", { exact: true })).toBeVisible();
	await contextMenu.getByText("Details", { exact: true }).click();

	await expect(page).toHaveURL(/\/tasks\?.*task=task-workbench/);
	await expect(page.getByText(task.subject, { exact: true })).toHaveCount(1);
	await expect(page.getByRole("tab", { name: "Details" })).toBeVisible();
});

test("runs the production Tabulator sheet inside a resizable Golden Layout pane", async ({ page }) => {
	await installMockApi(page, { tasks: [task, secondTask, draftTask] });
	await page.addInitScript(() => {
		window.localStorage.setItem("coleo-layout-mode", "golden");
		window.localStorage.setItem("coleo-theme", "dark");
		for (const key of Object.keys(window.localStorage)) {
			if (key.startsWith("coleo-golden-layout")) window.localStorage.removeItem(key);
		}
	});
	await page.goto("/tasks");

	const sheet = page.locator(".coleo-resource-sheet");
	await expect(sheet).toBeVisible({ timeout: 20_000 });
	await expect(sheet).toHaveClass(/tabulator/);
	await expect(page.locator(".handsontable")).toHaveCount(0);
	const table = sheet;
	const firstRow = table.locator('.tabulator-row[data-resource-id="task-workbench"]');
	const secondRow = table.locator('.tabulator-row[data-resource-id="task-second"]');
	await expect(firstRow).toBeVisible();
	await expect(secondRow).toBeVisible();

	await firstRow.click();
	await expect(firstRow).toHaveClass(/tabulator-selected/);
	await expect(firstRow).not.toHaveCSS("background-color", "rgb(255, 255, 255)");

	const subjectCell = firstRow.locator('.tabulator-cell[tabulator-field="subject"]');
	const subjectRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/tasks/task-workbench"
	);
	await subjectCell.dblclick();
	const subjectEditor = subjectCell.locator("input");
	await expect(subjectEditor).toBeVisible();
	await expect(subjectEditor).not.toHaveCSS("color", "rgb(0, 0, 0)");
	await subjectEditor.fill("Edit through the Tabulator spike");
	await subjectEditor.press("Enter");
	expect((await subjectRequest).postDataJSON()).toMatchObject({
		subject: "Edit through the Tabulator spike",
	});
	await expect(
		table.getByText("Edit through the Tabulator spike", { exact: true }),
	).toBeVisible();

	await secondRow
		.locator('.tabulator-cell[tabulator-field="phase"]')
		.click({ button: "right" });
	await page.locator(".tabulator-menu").getByText("Details", { exact: true }).click();
	await expect(
		page
			.locator('[data-card-template="workbench.resource-detail@2"]')
			.getByText(secondTask.subject, { exact: true }),
	).toBeVisible();

	const sheetBeforeResize = await sheet.boundingBox();
	const splitter = page.locator(".lm_splitter").first();
	const splitterBox = await splitter.boundingBox();
	if (!sheetBeforeResize || !splitterBox) throw new Error("Golden Layout split is not visible");
	await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + 40);
	await page.mouse.down();
	await page.mouse.move(splitterBox.x - 90, splitterBox.y + 40, { steps: 8 });
	await page.mouse.up();
	await expect
		.poll(async () => (await sheet.boundingBox())?.width ?? 0)
		.not.toBe(sheetBeforeResize.width);
	const resizedGridBounds = await sheet.evaluate((element) => {
		return {
			hostHeight: element.getBoundingClientRect().height,
			gridHeight: element.getBoundingClientRect().height,
		};
	});
	expect(Math.abs(resizedGridBounds.hostHeight - resizedGridBounds.gridHeight)).toBeLessThan(2);

	await firstRow
		.locator('.tabulator-cell[tabulator-field="phase"]')
		.click({ button: "right" });
	const createTaskRequest = page.waitForRequest((request) =>
		request.method() === "POST" &&
		new URL(request.url()).pathname === "/api/tasks"
	);
	await page.locator(".tabulator-menu").getByText("Insert row above", { exact: true }).click();
	expect((await createTaskRequest).postDataJSON()).toMatchObject({
		subject: "New task",
		status: "draft",
	});
	await expect(sheet.getByText("New task", { exact: true })).toBeVisible();
});

test("filters Draft tasks through the saved view shortcut", async ({ page }) => {
	await installMockApi(page, { tasks: [task, draftTask] });
	await page.goto("/tasks");
	const sheet = page.locator(".coleo-resource-sheet");
	await expect(sheet).toBeVisible({ timeout: 20_000 });
	const taskRow = sheet.locator('.tabulator-row[data-resource-id="task-workbench"]');
	const draftTaskRow = sheet.locator('.tabulator-row[data-resource-id="task-draft"]');
	await expect(taskRow).toBeVisible();
	await expect(draftTaskRow).toBeVisible();

	const draftsOnly = page.getByRole("button", { name: "Drafts Only", exact: true });
	await expect(draftsOnly).toHaveAttribute("aria-pressed", "false");
	const savedDraftFilter = page.waitForRequest((request) => {
		if (
			!["POST", "PUT"].includes(request.method()) ||
			!new URL(request.url()).pathname.startsWith("/api/workbench/views")
		) return false;
		const body = request.postDataJSON() as {
			preferences?: { filters?: Array<{ field?: string; operator?: string; value?: unknown }> };
		};
		return body.preferences?.filters?.some((filter) =>
			filter.field === "status" &&
			filter.operator === "equals" &&
			filter.value === "draft"
		) ?? false;
	});
	await draftsOnly.click();
	await expect(draftsOnly).toHaveAttribute("aria-pressed", "true");
	await expect(draftTaskRow).toBeVisible();
	await expect(taskRow).toHaveCount(0);
	await savedDraftFilter;

	await draftsOnly.click();
	await expect(draftsOnly).toHaveAttribute("aria-pressed", "false");
	await expect(taskRow).toBeVisible();
	await expect(draftTaskRow).toBeVisible();

	await page.getByRole("button", { name: "Configure tasks view: Default", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Configure view", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Hide Tags", exact: true }).click();
	await expect(sheet.getByRole("columnheader", { name: "Tags", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Show Tags", exact: true }).click();
	await expect(sheet.getByRole("columnheader", { name: "Tags", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Close configuration", exact: true }).click();
});

test("creates and selects a tag from the multiselect search", async ({ page }) => {
	await installMockApi(page, { bugs: [bug] });
	await page.goto("/bugs");
	const bugSheet = page.locator(".coleo-resource-sheet");
	const tagsCell = bugSheet.locator('.tabulator-cell[tabulator-field="tags"]');
	await expect(tagsCell).toBeVisible({ timeout: 20_000 });
	await tagsCell.dblclick();
	await expect(tagsCell).toHaveClass(/tabulator-editing/);
	const editor = page.locator(".coleo-tabulator-multiselect-editor");
	await expect(editor).toBeVisible();
	const search = editor.getByRole("searchbox", { name: "Search options" });
	await search.fill("release-2026");
	await expect(
		editor.getByRole("button", { name: "Use ASCII letters and numbers only" }),
	).toBeDisabled();

	await search.fill("performance");
	const addButton = editor.getByRole("button", {
		name: 'Add "performance" as a tag',
	});
	await expect(addButton).toBeEnabled();
	await addButton.click();
	await expect(editor.getByRole("checkbox", { name: "performance" })).toBeChecked();

	await search.fill("PERFORMANCE");
	await expect(
		editor.getByRole("button", {
			name: 'tag "performance" is already selected',
		}),
	).toBeDisabled();

	await search.fill("frontend");
	await search.press("Enter");
	await expect(editor.getByRole("checkbox", { name: "frontend" })).toBeChecked();
	const tagUpdateRequest = page.waitForRequest((request) =>
		request.method() === "PATCH" &&
		new URL(request.url()).pathname === "/api/bugs/bug-workbench"
	);
	await editor.getByRole("button", { name: "Apply", exact: true }).click();
	const requestBody = (await tagUpdateRequest).postDataJSON() as {
		metadata?: { ui?: { tags?: string[] } };
	};
	expect(requestBody.metadata?.ui?.tags).toEqual([
		"regression",
		"ui",
		"performance",
		"frontend",
	]);
	await expect(tagsCell.locator(".coleo-tabulator-tag")).toHaveText([
		"regression",
		"ui",
		"performance",
		"frontend",
	]);
});

test("manually orders task and bug rows from the Order gutter", async ({ page }) => {
	await installMockApi(page, {
		tasks: [task, secondTask],
		bugs: [bug, secondBug],
	});
	await page.goto("/tasks");
	const taskSheet = page.locator(".coleo-resource-sheet");
	await expect(taskSheet.getByRole("rowheader", { name: "1", exact: true })).toBeVisible({
		timeout: 20_000,
	});
	const taskReorder = page.waitForRequest((request) =>
		request.method() === "POST" &&
		new URL(request.url()).pathname === "/api/tasks/reorder"
	);
	await dragTabulatorRowAfter(
		page,
		taskSheet
			.locator('.tabulator-row[data-resource-id="task-workbench"]')
			.locator('.tabulator-cell[tabulator-field="subject"]'),
		taskSheet
			.locator('.tabulator-row[data-resource-id="task-second"]')
			.locator('.tabulator-cell[tabulator-field="subject"]'),
	);
	expect((await taskReorder).postDataJSON()).toMatchObject({
		taskId: task.id,
		prevTaskId: secondTask.id,
		nextTaskId: null,
	});
	await expect
		.poll(async () => {
			const renderedRows = await taskSheet.getByRole("row").allTextContents();
			return renderedRows.findIndex((row) => row.includes(secondTask.subject)) <
				renderedRows.findIndex((row) => row.includes(task.subject));
		})
		.toBe(true);
	const undoTaskReorder = page.waitForRequest((request) =>
		request.method() === "POST" &&
		new URL(request.url()).pathname === "/api/tasks/reorder"
	);
	await taskSheet
		.locator('.tabulator-row[data-resource-id="task-workbench"]')
		.getByRole("rowheader")
		.click();
	await page.keyboard.press("ControlOrMeta+Z");
	expect((await undoTaskReorder).postDataJSON()).toMatchObject({
		taskId: task.id,
		prevTaskId: null,
		nextTaskId: secondTask.id,
	});
	const redoTaskReorder = page.waitForRequest((request) =>
		request.method() === "POST" &&
		new URL(request.url()).pathname === "/api/tasks/reorder"
	);
	await taskSheet
		.locator('.tabulator-row[data-resource-id="task-workbench"]')
		.getByRole("rowheader")
		.click();
	await page.keyboard.press("ControlOrMeta+Shift+Z");
	expect((await redoTaskReorder).postDataJSON()).toMatchObject({
		taskId: task.id,
		prevTaskId: secondTask.id,
		nextTaskId: null,
	});

	await page.goto("/bugs");
	const bugSheet = page.locator(".coleo-resource-sheet");
	await expect(bugSheet.getByRole("rowheader", { name: "1", exact: true })).toBeVisible({
		timeout: 20_000,
	});
	const bugReorder = page.waitForRequest((request) =>
		request.method() === "POST" &&
		new URL(request.url()).pathname === "/api/bugs/reorder"
	);
	await dragTabulatorRowAfter(
		page,
		bugSheet
			.locator('.tabulator-row[data-resource-id="bug-workbench"]')
			.locator('.tabulator-cell[tabulator-field="title"]'),
		bugSheet
			.locator('.tabulator-row[data-resource-id="bug-second"]')
			.locator('.tabulator-cell[tabulator-field="title"]'),
	);
	expect((await bugReorder).postDataJSON()).toMatchObject({
		bugId: bug.id,
		toSortOrder: 1,
	});
	await expect
		.poll(async () => {
			const renderedRows = await bugSheet.getByRole("row").allTextContents();
			return renderedRows.findIndex((row) => row.includes(secondBug.title)) <
				renderedRows.findIndex((row) => row.includes(bug.title));
		})
		.toBe(true);
});
