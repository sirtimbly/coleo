/**
 * Browser protection for threaded Inbox viewing, reply context, and archive
 * actions after the legacy Project Mail screen is removed.
 */

import { expect, test } from "@playwright/test";

import { installMockApi } from "./support/fixtures";

const received = {
	id: "mail-received",
	from: "brain@coleo.local",
	to: "human@coleo.local",
	subject: "Workbench architecture",
	body: "The Brain has a question about the projection boundary.",
	date: "2026-08-02T11:00:00.000Z",
	headers: {
		"message-id": "<mail-received>",
		"x-coleo-thread-id": "thread-architecture",
	},
	flags: { seen: false, flagged: true },
};

const reply = {
	id: "mail-reply",
	from: "human@coleo.local",
	to: "brain@coleo.local",
	subject: "Re: Workbench architecture",
	body: "Keep the document editor specialized and share only its shell.",
	date: "2026-08-02T11:05:00.000Z",
	headers: {
		"message-id": "<mail-reply>",
		"in-reply-to": "<mail-received>",
		"references": "<mail-received>",
		"x-coleo-thread-id": "thread-architecture",
	},
	flags: { seen: true, flagged: false },
};

const brainPoll = {
	id: "brain-poll-1",
	sequence: 101,
	timestamp: "2026-08-02T11:10:00.000Z",
	actor: "brain",
	action: "poll_completed",
	target: null,
	details: {
		pendingTasks: 2,
		activeArms: 3,
		durationMs: 1200,
	},
};

const blockedTaskEvent = {
	type: "task.blocked",
	timestamp: "2026-08-02T11:15:00.000Z",
	armId: "arm-octavia",
	data: {
		taskId: "task-dashboard",
		status: "blocked",
	},
};

test("views indented message threads and carries reply context into the composer", async ({ page }) => {
	await installMockApi(page, { inbox: [received], sent: [reply] });
	await page.goto("/messaging?facet=messages&mailbox=inbox");

	await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Filter View: Messages" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Filter Mailbox: Inbox" })).toBeVisible();
	const messageRow = page.locator('[data-inbox-item-id="thread:inbox:thread-architecture"]');
	await expect(messageRow).toBeVisible();
	await messageRow.getByRole("button", { name: "Expand Workbench architecture card" }).click();
	await expect(messageRow.locator('[data-card-template="workbench.message@1"]')).toBeVisible();
	await messageRow.getByRole("button", { name: "Open conversation", exact: true }).click();

	await expect(page.getByRole("heading", { name: "Workbench architecture", exact: true })).toBeVisible();
	await expect(page.getByText(received.body)).toBeVisible();
	await expect(page.getByText(reply.body)).toBeVisible();
	await expect(page.locator('[data-thread-depth="1"]')).toBeVisible();

	await page.getByRole("button", { name: "Reply", exact: true }).first().click();
	await expect(page).toHaveURL("/compose");
	await expect(page.getByText("Replying to: Workbench architecture")).toBeVisible();
});

test("archives every inbox message represented by the open thread", async ({ page }) => {
	const archivedRequests: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "POST" && request.url().includes("/archive")) {
			archivedRequests.push(request.url());
		}
	});
	await installMockApi(page, { inbox: [received], sent: [reply] });
	await page.goto(
		"/messaging?facet=messages&mailbox=inbox&thread=thread-architecture",
	);

	await page.getByRole("button", { name: "Archive", exact: true }).click();
	await expect.poll(() => archivedRequests.length).toBe(1);
	await expect(page).toHaveURL("/messaging");
});

test("launcher navigation exposes the unified Inbox instead of legacy stream pages", async ({ page }) => {
	await installMockApi(page, { recentEvents: [blockedTaskEvent] });
	await page.goto("/");

	await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Notable events", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Open Inbox", exact: true }).click();

	await expect(page).toHaveURL(/\/messaging\?facet=attention$/);
	await expect(page.getByText("Task blocked: Task task-dashboard", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Project Mail", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "History", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Proposals", exact: true })).toHaveCount(0);

	await page.getByRole("button", { name: "Filter View: Needs attention" }).click();
	await page.getByRole("menuitemradio", { name: /^All/ }).click();
	await expect(page).toHaveURL(/\/messaging\?facet=all$/);

	const eventRow = page.locator(".tabulator-row").filter({
		hasText: "Task blocked: Task task-dashboard",
	});
	await eventRow.getByRole("button", {
		name: "Expand Task blocked: Task task-dashboard card",
	}).click();
	await expect(eventRow.locator('[data-card-template="workbench.event@1"]')).toBeVisible();
	await eventRow.getByRole("button", { name: "Open target", exact: true }).click();
	await expect(page).toHaveURL(/\/tasks\?task=task-dashboard&view=details$/);
});

test("Brain delegates its semantic activity feed to the live Inbox facet", async ({ page }) => {
	await installMockApi(page, { activity: [brainPoll] });
	await page.goto("/brain");

	await expect(page.getByRole("heading", { name: "Brain activity", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Open activity in Inbox" }).click();

	await expect(page).toHaveURL(/\/messaging\?facet=brain$/);
	await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
	await expect(page.locator(".coleo-inbox-card-table.tabulator")).toBeVisible();
	await expect(page.getByText("Poll completed", { exact: true })).toBeVisible();
	await expect(page.getByText("2 pending tasks, 3 active arms in 1.2s", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Filter Category: All" }).click();
	await page.getByRole("menuitemradio", { name: "Operations" }).click();
	await expect(page).toHaveURL(/\/messaging\?facet=brain&brainCategory=operations$/);
	await expect(page.getByText("Poll completed", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Beginning", exact: true })).toBeDisabled();
});

test("keeps following virtual rows below an expanded card", async ({ page }) => {
	await installMockApi(page, {
		activity: [brainPoll],
		recentEvents: [blockedTaskEvent],
	});
	await page.goto("/messaging?facet=all");

	const header = page.locator(".coleo-inbox-card-table .tabulator-header");
	await expect(header).toHaveCSS("background-color", "rgb(23, 27, 34)");
	await expect(header.locator(".tabulator-col").first()).toHaveCSS("color", "rgb(248, 250, 252)");
	const eventRow = page.locator(".tabulator-row").filter({
		hasText: "Task blocked: Task task-dashboard",
	});
	const followingRow = page.locator(".tabulator-row").filter({ hasText: "Poll completed" });
	const expander = eventRow.locator(".coleo-inbox-expand");
	const expanderIcon = expander.locator("svg.coleo-inbox-expand-icon");
	await expect(expander).toHaveAccessibleName("Expand Task blocked: Task task-dashboard card");
	await expect(expanderIcon).toBeVisible();
	await expect(expanderIcon).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
	await expander.click();
	await expect(expander).toHaveAccessibleName("Collapse Task blocked: Task task-dashboard card");
	await expect(expander).toHaveAttribute("aria-expanded", "true");
	await expect(expanderIcon).toHaveCSS("transform", "matrix(0, 1, -1, 0, 0, 0)");
	const card = eventRow.locator('[data-card-template="workbench.event@1"]');
	await expect(card).toBeVisible();
	await expect.poll(async () => {
		const cardBox = await card.boundingBox();
		const followingBox = await followingRow.boundingBox();
		if (!cardBox || !followingBox) return false;
		return followingBox.y >= cardBox.y + cardBox.height - 1;
	}).toBe(true);

	await expander.click();
	await expect(card).toHaveCount(0);
});
