import { expect, test } from "@playwright/test";

import { installMockApi } from "./support/fixtures";

const blockedTaskEvent = {
	type: "task.blocked",
	timestamp: "2026-08-02T11:15:00.000Z",
	armId: "arm-octavia",
	data: {
		taskId: "task-dashboard",
		status: "blocked",
	},
};

const task = {
	id: "task-card-view",
	subject: "Refine task card presentation",
	description: "Show this task description exactly once.",
	status: "pending",
	priority: "normal",
	sourceType: "manual",
	sourceRef: null,
	phase: "implementation",
	domain: "frontend",
	assignedTo: null,
	artifacts: [],
	metadata: {},
	progress: 0,
	sortOrder: 1,
	createdAt: "2026-08-02T11:00:00.000Z",
	updatedAt: "2026-08-02T12:00:00.000Z",
	completedAt: null,
};

test("previews the trusted catalog at narrow and wide panel widths", async ({ page }) => {
	await installMockApi(page);
	await page.setViewportSize({ width: 420, height: 900 });
	await page.goto("/card-catalog");

	await expect(page.getByRole("heading", { name: "Adaptive Card catalog" })).toBeVisible();
	await expect(page.getByText("Attention event", { exact: false })).toBeVisible();
	await expect(page.locator('[data-card-template="workbench.event@1"]')).toBeVisible();
	await expect(page.locator('[data-card-template="workbench.resource-editor@2"]')).toBeVisible();
	await expect(
		page.locator(
			'[data-card-template="workbench.event@1"][data-card-creator="brain:coleo-brain"]',
		),
	).toBeVisible();

	await page.setViewportSize({ width: 1024, height: 900 });
	await expect(page.locator('[data-card-template]')).toHaveCount(4);

	const eventCard = page.locator('[data-card-template="workbench.event@1"]');
	await eventCard.getByRole("button", { name: "Card view settings" }).click();
	await page.getByRole("menuitem", { name: "Compact this card" }).click();
	await expect(eventCard).toHaveAttribute("data-card-presentation", "compact");
	await expect(page.locator('[data-card-template="workbench.message@1"]'))
		.toHaveAttribute("data-card-presentation", "detail");

	await eventCard.getByRole("button", { name: "Card view settings" }).click();
	await page.getByRole("menuitem", { name: "Compact all cards" }).click();
	await expect(page.locator('[data-card-template="workbench.message@1"]'))
		.toHaveAttribute("data-card-presentation", "compact");
	await expect(page.locator('[data-card-template="workbench.resource-detail@2"]'))
		.toHaveAttribute("data-card-presentation", "compact");
	await expect(page.locator('[data-card-template="workbench.resource-editor@2"]'))
		.toHaveAttribute("data-card-presentation", "detail");
});

test("opens an Inbox event as a restorable card identity", async ({ page }) => {
	await installMockApi(page, { recentEvents: [blockedTaskEvent] });
	await page.goto("/messaging?facet=attention");

	const eventRow = page.locator(".tabulator-row").filter({
		hasText: "Task blocked: Task task-dashboard",
	});
	await eventRow.getByRole("button", {
		name: "Expand Task blocked: Task task-dashboard card",
	}).click();
	await expect(eventRow.locator('[data-card-template="workbench.event@1"]')).toBeVisible();
	await eventRow.getByRole("button", {
		name: "Open Task blocked: Task task-dashboard in panel",
	}).click();
	await expect(page.getByRole("button", { name: "Open card" })).toBeVisible();
	await page.getByRole("button", { name: "Open card" }).click();

	await expect(page).toHaveURL(/\/card\?id=018fd384-/);
	await expect(page.locator('[data-card-template="workbench.event@1"]')).toBeVisible();
	await expect(page.getByRole("button", { name: "Pop out" })).toBeVisible();
	await expect(page.getByText("workbench.event@1", { exact: true })).toHaveCount(0);
});

test("uses one task card with explicit detail and edit modes", async ({ page }) => {
	await installMockApi(page, { tasks: [task] });
	await page.goto("/tasks?task=task-card-view&view=details");

	const detailCard = page.locator('[data-card-template="workbench.resource-detail@2"]');
	await expect(detailCard).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText(task.description, { exact: true })).toHaveCount(1);
	await expect(page.getByText("You", { exact: true })).toBeVisible();
	await expect(detailCard.getByText(task.id, { exact: true })).toBeHidden();
	await detailCard.getByRole("button", { name: "More details" }).click();
	await expect(detailCard.getByText(task.id, { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Edit task or change status" }).click();
	await page.getByRole("menuitem", { name: "Edit task card" }).click();
	await expect(page.locator('[data-card-template="workbench.resource-editor@2"]')).toBeVisible();
	await expect(detailCard).toHaveCount(0);

	await page.getByRole("button", { name: "Edit task or change status" }).click();
	await page.getByRole("menuitem", { name: "Cancel card editing" }).click();
	await expect(page.locator('[data-card-template="workbench.resource-detail@2"]')).toBeVisible();
});
