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

test("views indented message threads and carries reply context into the composer", async ({ page }) => {
	await installMockApi(page, { inbox: [received], sent: [reply] });
	await page.goto("/messaging?facet=messages&mailbox=inbox");

	await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
	await page.getByRole("button", { name: /Workbench architecture/ }).click();

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
	await installMockApi(page);
	await page.goto("/messaging");

	await expect(page.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Project Mail", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "History", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Proposals", exact: true })).toHaveCount(0);
});
