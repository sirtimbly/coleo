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

test("previews the trusted catalog at narrow and wide panel widths", async ({ page }) => {
	await installMockApi(page);
	await page.setViewportSize({ width: 420, height: 900 });
	await page.goto("/card-catalog");

	await expect(page.getByRole("heading", { name: "Adaptive Card catalog" })).toBeVisible();
	await expect(page.getByText("Attention event", { exact: false })).toBeVisible();
	await expect(page.locator('[data-card-template="workbench.event@1"]')).toBeVisible();
	await expect(page.locator('[data-card-template="workbench.resource-editor@1"]')).toBeVisible();

	await page.setViewportSize({ width: 1024, height: 900 });
	await expect(page.locator('[data-card-template]')).toHaveCount(4);
});

test("opens an Inbox event as a restorable card identity", async ({ page }) => {
	await installMockApi(page, { recentEvents: [blockedTaskEvent] });
	await page.goto("/messaging?facet=attention");

	await page.getByRole("button", { name: /Task blocked: Task task-dashboard/ }).click();
	await expect(page.locator('[data-card-template="workbench.event@1"]')).toBeVisible();
	await page.getByRole("button", { name: "Open card" }).click();

	await expect(page).toHaveURL(/\/card\?id=018fd384-/);
	await expect(page.locator('[data-card-template="workbench.event@1"]')).toBeVisible();
	await expect(page.getByRole("button", { name: "Pop out" })).toBeVisible();
});
