import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/fixtures";

const event = { type: "poll_completed", timestamp: "2026-09-18T12:00:00Z", sequence: 101,
	data: { actor: "brain", activityId: "test-poll", pendingTasks: 2, activeArms: 3, durationMs: 1200 } };
const itemKey = "activity:test-poll";
const collections = new Set(["/api/activity", "/api/mail/inbox", "/api/mail/sent", "/api/mail/archive",
	"/api/status-reports", "/api/events/recent", "/api/workbench/inbox", "/api/workbench/attention"]);

test("a direct inbox item route fetches only its record and attention, and refreshes after actions", async ({ page }) => {
	await installMockApi(page);
	const collectionRequests: string[] = [];
	let reads = 0;
	page.on("request", (request) => {
		const url = new URL(request.url());
		const path = url.pathname;
		// The application sidebar independently requests the unread badge.
		if (path === "/api/mail/inbox" && url.searchParams.get("limit") === "1") return;
		if (collections.has(path)) collectionRequests.push(path);
	});
	await page.route("**/api/workbench/inbox/events/**", (route) => {
		reads++;
		return route.fulfill({ json: { event } });
	});
	await page.route("**/api/workbench/attention/activity*", (route) => route.fulfill({ json: { attention: { requiresAction: true } } }));
	await page.goto(`/messaging?item=${encodeURIComponent(itemKey)}&sequence=101`);
	await expect(page.locator('[data-card-template="workbench.event@1"]')).toBeVisible();
	await expect(page.getByText("Poll completed", { exact: true })).toBeVisible();
	expect(collectionRequests).toEqual([]);
	expect(reads).toBeGreaterThan(0);
	await page.getByRole("button", { name: "More options", exact: true }).click();
	await page.getByText("Mark resolved", { exact: true }).click();
	await expect.poll(() => reads).toBeGreaterThan(1);
	expect(collectionRequests).toEqual([]);
});

test("opening a visible card renders the handed-off record while its individual refresh is pending", async ({ page }) => {
	await installMockApi(page, { activity: [{ id: "test-poll", sequence: 101, timestamp: event.timestamp,
		actor: "brain", action: event.type, target: null, details: event.data }] });
	await page.goto("/messaging?facet=all");
	const row = page.locator('[data-inbox-item-id="activity:test-poll"]');
	await row.getByRole("button", { name: "Expand Poll completed card" }).click();
	await expect(row.locator('[data-card-template="workbench.event@1"]')).toBeVisible();
	const collectionRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		const path = url.pathname;
		// The application sidebar independently requests the unread badge.
		if (path === "/api/mail/inbox" && url.searchParams.get("limit") === "1") return;
		if (collections.has(path)) collectionRequests.push(path);
	});
	await page.route("**/api/workbench/inbox/events/**", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 2500));
		await route.fulfill({ json: { event } });
	});
	await page.route("**/api/workbench/attention/activity*", (route) => route.fulfill({ json: { attention: null } }));
	await row.getByRole("button", { name: "Open Poll completed in panel" }).click();
	await expect(page.locator('[data-card-template="workbench.event@1"][data-card-presentation="detail"]')).toBeVisible({ timeout: 1500 });
	await expect(page.getByText("Loading inbox item", { exact: true })).toHaveCount(0);
	expect(collectionRequests).toEqual([]);
});

test("a missing record has an unavailable state rather than an endless loading screen", async ({ page }) => {
	await installMockApi(page);
	await page.route("**/api/workbench/inbox/records/**", (route) => route.fulfill({ status: 404, json: { error: "Inbox task not found" } }));
	await page.route("**/api/workbench/attention/task*", (route) => route.fulfill({ json: { attention: null } }));
	await page.goto("/messaging?item=task%3Amissing");
	await expect(page.getByRole("heading", { name: "Inbox item unavailable" })).toBeVisible();
	await expect(page.getByText("Loading inbox item", { exact: true })).toHaveCount(0);
});
