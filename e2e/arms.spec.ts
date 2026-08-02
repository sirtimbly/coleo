/**
 * Browser protection for the Arm fleet and its handoff to the live Viewer.
 */

import { expect, test } from "@playwright/test";

import { installMockApi } from "./support/fixtures";

const activeArm = {
	id: "arm-octavia",
	name: "Octavia",
	status: "busy",
	harness: "opencode-api",
	provider: "openai",
	model: "gpt-5",
	contextBudget: 128000,
	currentContextUsed: 24000,
	currentTaskSubject: "Unify the workbench",
	createdAt: "2026-08-02T11:00:00.000Z",
	updatedAt: "2026-08-02T12:00:00.000Z",
};

test("shows fleet status and assignments in the Arms projection", async ({ page }) => {
	await installMockApi(page, { arms: [activeArm] });
	await page.goto("/arms");

	await expect(page.getByRole("heading", { name: "Arms", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: /Octavia/ })).toBeVisible();
	await expect(page.getByText("Task · Unify the workbench")).toBeVisible();
	await expect(page.getByRole("button", { name: "Spawn" })).toBeVisible();
});

test("opens the selected Arm in the dedicated Viewer route", async ({ page }) => {
	await installMockApi(page, { arms: [activeArm] });
	await page.goto("/arms");
	await page.getByRole("button", { name: /Octavia/ }).click();

	await expect(page).toHaveURL(/\/viewer\?arm=arm-octavia/);
	await expect(page.getByRole("heading", { name: /Octavia/ })).toBeVisible();
});
