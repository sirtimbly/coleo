import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/fixtures";
import { fixtureMessagingPage } from "./support/messaging";
import type { FixtureMail } from "./support/messaging";

const activity = { id: "recovery-poll", sequence: 101, timestamp: "2026-10-01T12:00:00Z",
	actor: "brain", action: "poll_completed", target: null, details: { pendingTasks: 2, activeArms: 3, durationMs: 1200 } };

test("an outdated live API envelope is unavailable with restart guidance, never a legitimate empty view", async ({ page }) => {
	await installMockApi(page);
	await page.route("**/api/workbench/inbox?**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
	await page.goto("/messaging?facet=messages");
	await expect(page.getByRole("heading", { name: "Inbox unavailable", exact: true })).toBeVisible();
	await expect(page.getByRole("alert")).toContainText("Restart the Coleo API server");
	await expect(page.getByText("Nothing in this view", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Messaging response belongs to another query", { exact: true })).toHaveCount(0);
});

test("loads a scoped collection once and does not fan out to old collection APIs", async ({ page }) => {
	await installMockApi(page, { activity: [activity] });
	const paths: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname === "/api/mail/inbox" && url.searchParams.get("limit") === "1") return;
		if (["/api/activity", "/api/mail/inbox", "/api/mail/sent", "/api/mail/archive", "/api/status-reports", "/api/events/recent", "/api/workbench/inbox", "/api/workbench/attention"].includes(url.pathname)) paths.push(url.pathname);
	});
	await page.goto("/messaging?facet=brain");
	await expect(page.getByText("Poll completed", { exact: true })).toBeVisible();
	expect(paths).toEqual(["/api/workbench/inbox"]);
});

test("old query responses cannot replace a newer facet and unavailable sources retain the current window", async ({ page }) => {
	await installMockApi(page, { activity: [activity] });
	let unavailable = false;
	await page.route("**/api/workbench/inbox?**", async (route) => {
		const query = JSON.parse(new URL(route.request().url()).searchParams.get("query")!);
		if (query.facet === "all") await new Promise((resolve) => setTimeout(resolve, 500));
		const base = fixtureMessagingPage({ activity: [activity] }, query);
		const result = unavailable ? { ...base, items: [], sources: base.sources.map((source) => source.id === "activity"
			? { ...source, status: "unavailable", complete: false } : source), summaries: { ...base.summaries, complete: false } } : base;
		await route.fulfill({ json: result });
	});
	await page.goto("/messaging?facet=brain");
	await expect(page.getByText("Poll completed", { exact: true })).toBeVisible();
	unavailable = true;
	await page.getByRole("button", { name: "Refresh inbox", exact: true }).click();
	await expect(page.getByText(/Incomplete Inbox:/)).toBeVisible();
	await expect(page.getByText("Poll completed", { exact: true })).toBeVisible();
	unavailable = false;
	await page.getByRole("button", { name: "Filter View: Brain" }).click();
	await page.getByRole("menuitemradio", { name: /^All/ }).click();
	await page.getByRole("button", { name: "Filter View: All" }).click();
	await page.getByRole("menuitemradio", { name: /^Messages/ }).click();
	await expect(page.getByRole("button", { name: "Filter View: Messages" })).toBeVisible();
	await expect(page.getByText("Poll completed", { exact: true })).toHaveCount(0);
	await page.waitForTimeout(700);
	await expect(page.getByText("Poll completed", { exact: true })).toHaveCount(0);
});

test("continuous change hints refresh before silence and socket-only recovery reloads the active query", async ({ page }) => {
	await installMockApi(page, { activity: [activity] });
	const sockets: Array<{ send: (data: string) => void; close: () => void }> = [];
	await page.routeWebSocket("**/ws", (socket) => {
		sockets.push(socket);
		socket.onMessage((data) => { const message = JSON.parse(String(data));
			if (message.type === "auth") socket.send(JSON.stringify({ type: "auth", success: true }));
		});
	});
	let requests = 0;
	let pendingTasks = 2;
	await page.route("**/api/workbench/inbox?**", async (route) => {
		requests++;
		const result = fixtureMessagingPage({ activity: [{ ...activity, details: { ...activity.details, pendingTasks } }] },
			JSON.parse(new URL(route.request().url()).searchParams.get("query")!));
		await new Promise((resolve) => setTimeout(resolve, 80));
		await route.fulfill({ json: result });
	});
	await page.goto("/messaging?facet=brain");
	await expect(page.getByText("2 pending tasks, 3 active arms in 1.2s", { exact: true })).toBeVisible();
	await expect.poll(() => sockets.length).toBe(1);
	pendingTasks = 7;
	const burst = setInterval(() => sockets[0]!.send(JSON.stringify({ type: "event", channel: "brain", event: "brain.poll_completed", timestamp: new Date().toISOString(), data: {} })), 40);
	try { await expect(page.getByText("7 pending tasks, 3 active arms in 1.2s", { exact: true })).toBeVisible({ timeout: 1500 }); }
	finally { clearInterval(burst); }
	expect(requests).toBeLessThan(12);
	pendingTasks = 9;
	sockets[0]!.close();
	await expect.poll(() => sockets.length).toBe(2);
	await expect(page.getByText("9 pending tasks, 3 active arms in 1.2s", { exact: true })).toBeVisible();
});

test("production reply branches retain selected descendants on collapse and new replies remain unselected", async ({ page }) => {
	const message = { id: "root-mail", from: "human@example.test", to: "brain@example.test", subject: "Review branch", body: "Root",
		date: "2026-10-01T12:00:00Z", headers: { "message-id": "<root>", "x-coleo-thread-id": "review" }, flags: { seen: false } };
	const reply = { ...message, id: "reply-mail", subject: "API branch", date: "2026-10-01T12:01:00Z",
		headers: { "message-id": "<reply>", "x-coleo-thread-id": "review", "in-reply-to": "<root>" } };
	await installMockApi(page, { inbox: [message, reply] });
	let inbox: FixtureMail[] = [message, reply];
	await page.route("**/api/workbench/inbox?**", (route) => route.fulfill({ json: fixtureMessagingPage({ inbox },
		JSON.parse(new URL(route.request().url()).searchParams.get("query")!)) }));
	await page.goto("/messaging?facet=messages");
	const root = page.locator('[data-inbox-item-id="thread:inbox:review"]');
	await root.getByRole("button", { name: "Expand Review branch card" }).click();
	await root.getByRole("checkbox", { name: "Select loaded branch Review branch" }).check();
	await expect(page.getByText("2 loaded members selected", { exact: true })).toBeVisible();
	await root.getByRole("button", { name: "Collapse replies to Review branch" }).click();
	await expect(root.getByRole("button", { name: "Collapse Review branch card", exact: true })).toBeVisible();
	await expect(root.locator('[data-message-node-id="message:<reply>"]')).toHaveCount(0);
	await expect(page.getByText("2 loaded members selected", { exact: true })).toBeVisible();
	inbox = [...inbox, { ...reply, id: "new-mail", subject: "New API reply", date: "2026-10-01T12:02:00Z",
		headers: { ...reply.headers, "message-id": "<new>", "in-reply-to": "<root>" } }];
	await page.getByRole("button", { name: "Refresh inbox", exact: true }).click();
	await root.getByRole("button", { name: "Expand replies to Review branch" }).click();
	await expect(root.getByRole("checkbox", { name: "Select loaded branch New API reply" })).not.toBeChecked();
	await expect(root.getByRole("checkbox", { name: "Select loaded branch Review branch" })).toHaveJSProperty("indeterminate", true);
});

test("root sort changes the service query and table order while preserving expanded cards", async ({ page }) => {
	const newer = { ...activity, id: "newer-poll", sequence: 102, timestamp: "2026-10-01T13:00:00Z" };
	await installMockApi(page, { activity: [activity, newer] });
	await page.goto("/messaging?facet=brain");
	const olderRow = page.locator('[data-inbox-item-id="activity:recovery-poll"]');
	await olderRow.getByRole("button", { name: "Expand Poll completed card" }).click();
	await page.getByRole("button", { name: "Filter Sort: Newest first" }).click();
	const response = page.waitForResponse((result) => {
		const query = new URL(result.url()).searchParams.get("query");
		return query !== null && JSON.parse(query).sort.direction === "asc";
	});
	await page.getByRole("menuitemradio", { name: "Oldest first" }).click();
	await response;
	await expect(page.locator('.coleo-inbox-card-table .tabulator-row').first()).toHaveAttribute("data-inbox-item-id", "activity:recovery-poll");
	await expect(olderRow.getByRole("button", { name: "Collapse Poll completed card" })).toBeVisible();
});

test("top Mark Read reads the exact nested selection and settles after one post-action refresh", async ({ page }) => {
	const root: FixtureMail = { id: "selected-root", from: "human@example.test", to: "brain@example.test", subject: "Selected conversation", body: "Root",
		date: "2026-10-01T12:00:00Z", headers: { "message-id": "<selected-root>", "x-coleo-thread-id": "selected" }, flags: { seen: false } };
	const selected = [root, ...[1, 2, 3].map((index) => ({ ...root, id: `selected-${index}`, date: `2026-10-01T12:0${index}:00Z`,
		subject: index === 1 ? "Nested branch" : index === 2 ? "Nested child" : "Unselected sibling",
		headers: { "message-id": `<selected-${index}>`, "x-coleo-thread-id": "selected", "in-reply-to": index === 2 ? "<selected-1>" : "<selected-root>" }, flags: { seen: false } }))];
	const other: FixtureMail = { ...root, id: "other", subject: "Unselected conversation",
		headers: { "message-id": "<other>", "x-coleo-thread-id": "other" }, flags: { seen: false } };
	let inbox = [...selected, other];
	await installMockApi(page, { inbox });
	let socket: { send: (data: string) => void } | undefined;
	await page.routeWebSocket("**/ws", (route) => {
		socket = route;
		route.onMessage((data) => { if (JSON.parse(String(data)).type === "auth") route.send(JSON.stringify({ type: "auth", success: true })); });
	});
	let collections = 0, actions = 0, collectionsDuringAction = 0;
	let finishAction!: () => void;
	const actionGate = new Promise<void>((resolve) => { finishAction = resolve; });
	await page.route("**/api/workbench/inbox?**", (route) => {
		collections++;
		return route.fulfill({ json: fixtureMessagingPage({ inbox }, JSON.parse(new URL(route.request().url()).searchParams.get("query")!)) });
	});
	await page.route("**/api/mail/threads/*/actions", async (route) => {
		actions++;
		const body = route.request().postDataJSON() as { memberIds: string[]; action: string };
		expect(new URL(route.request().url()).pathname).toBe("/api/mail/threads/selected/actions");
		expect(body.action).toBe("read");
		expect(body.memberIds).toEqual(["message:<selected-1>", "message:<selected-2>"]);
		const started = collections;
		for (let i = 0; i < 3; i++) {
			socket?.send(JSON.stringify({ type: "event", channel: "mail", event: "mail.read", timestamp: new Date().toISOString(), data: {} }));
		}
		await actionGate;
		collectionsDuringAction = collections - started;
		inbox = inbox.map((message) => ["selected-1", "selected-2"].includes(message.id) ? { ...message, flags: { seen: true } } : message);
		await route.fulfill({ json: { ok: true, completedMessageIds: ["selected-1", "selected-2"], skippedMemberIds: [] } });
	});
	await page.goto("/messaging?facet=messages");
	const row = page.locator('[data-inbox-item-id="thread:inbox:selected"]');
	await row.getByRole("button", { name: "Expand Selected conversation card" }).click();
	await row.getByRole("checkbox", { name: "Select loaded branch Nested branch" }).check();
	const before = collections;
	await page.getByRole("toolbar", { name: "Inbox controls" }).getByRole("button", { name: "Mark selected read", exact: true }).click();
	await expect(page.getByRole("button", { name: "Marking read…", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Filter Sort: Newest first" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Filter View: Messages" })).toBeDisabled();
	await expect(page.getByPlaceholder("Search this inbox…")).toBeDisabled();
	finishAction();
	await expect(page.getByRole("button", { name: "Mark selected read", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Refresh inbox", exact: true }).locator("svg")).not.toHaveClass(/animate-spin/);
	expect(actions).toBe(1);
	expect(collectionsDuringAction).toBe(0);
	expect(collections - before).toBe(1);
	await expect(page.locator('[data-inbox-item-id="thread:inbox:other"]')).toHaveClass(/coleo-inbox-row-unread/);
	await expect(row.locator('[data-message-node-id="message:<selected-3>"]')).toContainText("Unread");
	await expect(row.locator('[data-message-node-id="message:<selected-root>"]')).toContainText("Unread");
	await expect(row.locator('[data-message-node-id="message:<selected-1>"]')).toContainText("Read");
	await expect(page.getByText(/Incomplete Inbox:/)).toHaveCount(0);
});
