/**
 * Observatory surface failure matrix.
 *
 * Each surface must degrade to an explicit error or empty state (never a
 * blank screen or a crash) when its API contract fails. Additional
 * surfaces follow the same installMockApi + override pattern.
 */
import { expect, test } from "@playwright/test";

import { installMockApi } from "./support/fixtures";

test("arms surface shows an explicit error when its API is unavailable", async ({
	page,
}) => {
	await installMockApi(page);
	await page.route("**/api/arms*", (route) => route.abort());
	await page.goto("/arms");

	await expect(
		page.getByText("Unable to load Arms", { exact: true }),
	).toBeVisible();
	// Shell navigation survives the surface failure.
	await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
});

test("bugs surface alerts on expired authentication", async ({ page }) => {
	await installMockApi(page);
	await page.route("**/api/bugs*", (route) =>
		route.fulfill({
			status: 401,
			contentType: "application/json",
			body: JSON.stringify({ error: "Unauthorized" }),
		}),
	);
	await page.goto("/bugs");

	await expect(page.getByRole("alert").first()).toBeVisible();
});

test("arms surface renders an empty state for an empty fleet", async ({
	page,
}) => {
	await installMockApi(page, { arms: [] });
	await page.goto("/arms");

	await expect(
		page.getByText("No arms registered yet", { exact: true }),
	).toBeVisible();
});

test("garden surface shows an explicit error when scene load fails", async ({
	page,
}) => {
	await installMockApi(page);
	await page.route("**/api/garden*", (route) => route.abort());
	await page.goto("/garden");

	await expect(
		page.getByText("Unable to load Garden", { exact: true }),
	).toBeVisible();
});
