import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/fixtures";

const activity = { id: "stable-event", sequence: 101, timestamp: "2026-09-21T12:00:00Z",
	actor: "brain", action: "poll_completed", target: null,
	details: { pendingTasks: 2, activeArms: 3, durationMs: 1200 } };

test("expanded cards retain their DOM through repeated refreshes and new rows", async ({ page }) => {
	await installMockApi(page, { activity: [activity] });
	let rows = [activity];
	await page.route("**/api/activity?**", (route) => route.fulfill({ json: {
		activity: rows, pagination: { limit: 200, offset: 0, total: rows.length, hasMore: false, nextCursor: null },
	} }));
	await page.goto("/messaging?facet=all");
	const row = page.locator('[data-inbox-item-id="activity:stable-event"]');
	await row.getByRole("button", { name: "Expand Poll completed card" }).click();
	const card = row.locator('[data-card-template="workbench.event@1"]');
	await expect(card.getByText("2 pending tasks, 3 active arms in 1.2s", { exact: true })).toBeVisible();
	await card.locator('.ac-adaptiveCard').evaluate((element) => element.setAttribute('data-stability-probe', 'retained'));
	for (let i = 0; i < 5; i++) {
		if (i === 2) rows = [activity, { ...activity, id: "new-event", sequence: 102, timestamp: "2026-09-21T12:01:00Z" }];
		const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/activity");
		await page.getByRole("button", { name: "Refresh inbox", exact: true }).click();
		await refreshed;
		await expect(page.getByRole("button", { name: "Refresh inbox", exact: true }).locator("svg")).not.toHaveClass(/animate-spin/);
		await expect(card.locator('[data-stability-probe="retained"]')).toBeVisible();
		await expect(row.getByRole("button", { name: "Collapse Poll completed card" })).toBeVisible();
	}
	await expect(page.locator('[data-inbox-item-id="activity:new-event"]')).toBeVisible();
	rows = [{ ...activity, details: { ...activity.details, pendingTasks: 9 } }];
	await page.getByRole("button", { name: "Refresh inbox", exact: true }).click();
	await expect(card.getByText("9 pending tasks, 3 active arms in 1.2s", { exact: true })).toBeVisible();
	await expect(row.locator(".coleo-inbox-subject-summary")).toHaveText("9 pending tasks, 3 active arms in 1.2s");
	// Brain history is accumulated across refreshes; filtering removes a row from the table.
	await page.getByPlaceholder("Search this inbox…").fill("9 pending tasks");
	await expect(page.locator('[data-inbox-item-id="activity:new-event"]')).toHaveCount(0);
	await card.getByText("9 pending tasks, 3 active arms in 1.2s", { exact: true }).click();
	await expect(row.getByRole("button", { name: "Collapse Poll completed card" })).toBeVisible();
	await card.getByRole("button", { name: "Open Poll completed in panel" }).click();
	await expect(page.locator('[data-card-template="workbench.event@1"][data-card-presentation="detail"]')).toBeVisible();
});

test("opening a Golden Layout side panel keeps the original inbox mounted and filtered", async ({ page }) => {
	await installMockApi(page, { activity: [activity] });
	await page.addInitScript(() => localStorage.setItem("coleo-layout-mode", "golden"));
	await page.route("**/api/workbench/inbox/events/**", (route) => route.fulfill({ json: { event: {
		type: activity.action, timestamp: activity.timestamp, sequence: activity.sequence,
		data: { ...activity.details, actor: activity.actor, activityId: activity.id },
	} } }));
	await page.route("**/api/workbench/attention/activity*", (route) => route.fulfill({ json: { attention: null } }));
	await page.goto("/messaging?facet=all");
	const search = page.getByPlaceholder("Search this inbox…");
	await search.fill("Poll completed");
	const row = page.locator('[data-inbox-item-id="activity:stable-event"]');
	await row.getByRole("button", { name: "Expand Poll completed card" }).click();
	const card = row.locator('[data-card-template="workbench.event@1"]');
	await expect(card.locator('.ac-adaptiveCard')).toBeVisible();
	await card.locator('.ac-adaptiveCard').evaluate((element) => element.setAttribute('data-stability-probe', 'retained'));
	let collectionRequests = 0;
	page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/activity") collectionRequests++; });
	await card.getByRole("button", { name: "Open Poll completed in panel" }).click();
	await expect(page.locator(".lm_tab")).toHaveCount(2);
	await expect(page.locator('[data-card-template="workbench.event@1"][data-card-presentation="detail"]')).toBeVisible();
	await expect(search).toHaveValue("Poll completed");
	await expect(card.locator('[data-stability-probe="retained"]')).toBeVisible();
	await expect(page.getByText("Nothing in this view", { exact: true })).toHaveCount(0);
	expect(collectionRequests).toBe(0);
});
