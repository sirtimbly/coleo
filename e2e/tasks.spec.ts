/**
 * Browser protection for the editable Tasks sheet and its Golden Layout
 * detail handoff.
 */

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

test("renders tasks in the configurable spreadsheet", async ({ page }) => {
	await installMockApi(page, { tasks: [task] });
	await page.goto("/tasks");

	await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
	await expect(page.getByText("Protect the critical workbench", { exact: true })).toBeVisible();
	await expect(page.getByText(/double-click a row for details/i)).toBeVisible();
});

test("opens a spreadsheet row in the dedicated task detail projection", async ({ page }) => {
	await installMockApi(page, { tasks: [task] });
	await page.goto("/tasks");
	await page.getByText("Protect the critical workbench", { exact: true }).dblclick();

	await expect(page).toHaveURL(/\/tasks\?.*task=task-workbench/);
	await expect(
		page.getByRole("heading", { name: "Protect the critical workbench", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("tab", { name: "Details" })).toBeVisible();
});
