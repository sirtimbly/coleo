import { expect, test } from "@playwright/test";
import { getNamedResourceView, resolveNamedResourceView } from "../src/workbench/named-resource-views";
import { installMockApi } from "./support/fixtures";
import { fixtureMessagingPage } from "./support/messaging";

const activity = { id: "named-poll", sequence: 101, timestamp: "2026-10-01T12:00:00Z",
	actor: "brain", action: "poll_completed", target: null, details: { pendingTasks: 2, activeArms: 3, durationMs: 1200 } };

test("the browser uses resolved named query defaults and fields, and presentation changes preserve the query", async ({ page }) => {
	const persistenceErrors: string[] = [];
	page.on("console", (message) => { if (message.type() === "error" && /dehydrated.*pending/.test(message.text())) persistenceErrors.push(message.text()); });
	await installMockApi(page, { activity: [activity] });
	await page.routeWebSocket("**/ws", (socket) => {
		socket.onMessage((data) => { if (JSON.parse(String(data)).type === "auth") socket.send(JSON.stringify({ type: "auth", success: true })); });
	});
	await page.setViewportSize({ width: 1800, height: 900 });
	const builtin = getNamedResourceView("inbox-triage", "web")!;
	const definition = { ...builtin.definition, query: { ...builtin.definition.query, facet: "brain", search: "poll", sort: { field: "timestamp", direction: "asc" } },
		presentation: { ...builtin.definition.presentation, renderers: builtin.definition.presentation.renderers.map((renderer) => renderer.id === "grid" ? { ...renderer, fields: ["title"] } : renderer) } };
	await page.route("**/api/workbench/named-views/inbox-triage?**", (route) => route.fulfill({ json: resolveNamedResourceView(definition, "web") }));
	const queries: Record<string, unknown>[] = [];
	page.on("request", (request) => { const url = new URL(request.url());
		if (url.pathname === "/api/workbench/inbox") queries.push(JSON.parse(url.searchParams.get("query")!));
	});
	await page.goto("/messaging?view=inbox-triage");
	await expect(page.getByRole("heading", { name: "Inbox triage", exact: true })).toBeVisible();
	await expect(page.getByText("Poll completed", { exact: true })).toBeVisible();
	expect(queries).toHaveLength(1);
	expect(queries[0]).toMatchObject({ facet: "brain", search: "poll", sort: { direction: "asc" } });
	await expect(page.getByPlaceholder("Search this inbox…")).toHaveValue("poll");
	await expect(page.locator('.coleo-inbox-card-table .tabulator-col[tabulator-field="source"]')).toHaveCount(0);
	await expect(page.locator('[data-resource-slot="toolbar.secondary.sort"]')).toBeVisible();
	await page.getByRole("button", { name: "Filter Presentation: Resource grid" }).click();
	await page.getByRole("menuitemradio", { name: "Activity timeline" }).click();
	await expect(page.getByRole("list", { name: "Inbox text list" })).toContainText("Poll completed");
	await expect(page.getByText("Using collection.list instead of messaging.timeline", { exact: true })).toBeVisible();
	expect(queries).toHaveLength(1);
	await expect(page.getByRole("region", { name: "Inbox metadata" })).toHaveCount(0);
	await page.getByRole("button", { name: "Metadata overview", exact: true }).click();
	await expect(page.getByRole("region", { name: "Inbox metadata" })).toContainText("Complete current query");
	const metadataButton = page.getByRole("button", { name: "Metadata overview", exact: true });
	await expect(metadataButton).toHaveAttribute("aria-pressed", "true");
	await expect(metadataButton).toHaveClass(/button--secondary/);
	await metadataButton.click();
	await expect(metadataButton).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByRole("region", { name: "Inbox metadata" })).toHaveCount(0);
	expect(persistenceErrors).toEqual([]);
});

test("named shortcuts and generated help respect typing, modifiers, and local focus", async ({ page }) => {
	await installMockApi(page, { activity: [activity] });
	let collections = 0;
	page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/workbench/inbox") collections++; });
	await page.goto("/messaging?view=inbox-triage&facet=brain");
	await expect(page.getByText("Poll completed", { exact: true })).toBeVisible();
	const collection = page.getByLabel("Named Inbox view inbox-triage", { exact: true });
	await collection.focus();
	await page.keyboard.press("/");
	const search = page.getByPlaceholder("Search this inbox…");
	await expect(search).toBeFocused();
	await search.pressSequentially("r?");
	await expect(search).toHaveValue("r?");
	await expect(page.getByRole("region", { name: "Interaction help" })).toHaveCount(0);
	await search.fill("");
	await expect(page.getByText("Poll completed", { exact: true })).toBeVisible();
	await collection.focus();
	await page.keyboard.press("?");
	const help = page.getByRole("region", { name: "Interaction help", exact: true });
	await expect(help).toBeVisible();
	await expect(help).toContainText("--search / -s <string>");
	await expect(help).toContainText("No web adapter for collection.next");
	await page.keyboard.press("Escape");
	await expect(help).toHaveCount(0);
	await expect(collection).toBeFocused();
	const helpButton = page.getByRole("button", { name: "Keyboard help", exact: true });
	await helpButton.click();
	await expect(help).toBeVisible();
	await expect(helpButton).toHaveAttribute("aria-pressed", "true");
	await expect(helpButton).toHaveClass(/button--secondary/);
	await helpButton.click();
	await expect(help).toHaveCount(0);
	await expect(helpButton).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByRole("button", { name: "Refresh inbox", exact: true })).toBeEnabled();
	const before = collections;
	await collection.dispatchEvent("keydown", { key: "r", ctrlKey: true });
	await collection.dispatchEvent("keydown", { key: "r", isComposing: true });
	expect(collections).toBe(before);
	await page.keyboard.press("r");
	await expect.poll(() => collections).toBe(before + 1);
});

test("an unresolved named view is an explicit failure and does not silently load the default Inbox", async ({ page }) => {
	await installMockApi(page);
	let collections = 0;
	page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/workbench/inbox") collections++; });
	await page.goto("/messaging?view=missing-view");
	await expect(page.getByRole("alert")).toContainText("Named resource view not found");
	await expect(page.getByRole("button", { name: "Retry named view" })).toBeVisible();
	await expect(page.getByText("Nothing in this view", { exact: true })).toHaveCount(0);
	expect(collections).toBe(0);
});

test("named toolbar controls stay legible and within their tiers in wide and narrow panes", async ({ page }) => {
	const message = { id: "toolbar-mail", from: "human@example.test", to: "brain@example.test", subject: "Toolbar conversation", body: "Fixture",
		date: "2026-10-01T12:00:00Z", headers: { "message-id": "<toolbar>", "x-coleo-thread-id": "toolbar" }, flags: { seen: true } };
	await installMockApi(page, { inbox: [message], layoutMode: "golden" });
	await page.route("**/api/workbench/inbox?**", (route) => {
		const query = JSON.parse(new URL(route.request().url()).searchParams.get("query")!);
		const result = fixtureMessagingPage({ inbox: [message] }, query);
		return route.fulfill({ json: { ...result, summaries: { ...result.summaries, total: 7845 } } });
	});
	await page.goto("/messaging?view=inbox-triage&facet=messages");
	await expect(page.getByRole("button", { name: "Filter View: Messages" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Filter Mailbox: Inbox" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Keyboard help", exact: true })).toBeVisible();
	await expect(page.locator('[data-resource-control="heading"]').getByLabel("Messaging source freshness"))
		.toHaveText("mail: fresh");
	await expect(page.getByLabel("Messaging source freshness")).toHaveCount(1);
	await expect(page.getByText("No selected members", { exact: true })).toHaveCount(0);
	for (const width of [1400, 980, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await expect.poll(() => page.locator('.resource-toolbar').getAttribute('data-layout-rows')).toMatch(/^[12]$/);
		await expect.poll(async () => page.locator('[data-toolbar-row^="named-"]').evaluateAll((toolbars) => {
			const problems: string[] = [];
			for (const toolbar of toolbars) {
				const bounds = toolbar.getBoundingClientRect();
				if (toolbar.scrollWidth > toolbar.clientWidth + 1) problems.push(`toolbar overflows ${toolbar.scrollWidth}/${toolbar.clientWidth}: ${[...toolbar.querySelectorAll<HTMLElement>("[data-resource-control]")]
					.map((control) => `${control.dataset.resourceControl}=${control.getBoundingClientRect().width}/${control.dataset.measuredWidth}`).join(", ")}`);
				const controls = [...toolbar.querySelectorAll<HTMLElement>("button, input")];
				for (const control of controls) {
					const box = control.getBoundingClientRect();
					const label = control.getAttribute("aria-label") ?? control.textContent;
					if (box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.bottom > bounds.bottom + 1) problems.push(`clipped: ${label}`);
					if (box.height > 33 || parseFloat(getComputedStyle(control).fontSize) > 12.5) problems.push(`oversized: ${label}`);
					if (control.hasAttribute("data-projection-menu-trigger") && control.scrollWidth > control.clientWidth + 1) problems.push(`squeezed: ${label}`);
					if (control.hasAttribute("data-projection-menu-trigger")) {
						const value = control.querySelector<HTMLElement>('[data-toolbar-value]');
						if (!value || getComputedStyle(value).display === 'none' || value.getBoundingClientRect().width < 8) problems.push(`dropdown value hidden: ${label}`);
					}
				}
				for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
					const a = controls[i]!.getBoundingClientRect(), b = controls[j]!.getBoundingClientRect();
					if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) problems.push("overlapping controls");
				}
			}
			return problems;
		})).toEqual([]);
	}
	await expect(page.locator('.resource-toolbar')).toHaveAttribute('data-identity-hidden', 'true');
	await expect(page.locator('.resource-toolbar')).toHaveAttribute('data-labels', 'icons');
	await page.setViewportSize({ width: 320, height: 900 });
	await expect(page.locator('.resource-toolbar').getByRole('button', { name: 'Metadata overview', exact: true })).toBeVisible();
	await expect(page.locator('.resource-toolbar').getByRole('button', { name: 'Keyboard help', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'More Inbox controls', exact: true }).click();
	const overflow = page.getByRole('dialog', { name: 'More Inbox controls', exact: true });
	await expect(overflow.getByRole('heading', { name: 'Actions', exact: true })).toBeVisible();
	await expect(overflow.getByRole('button', { name: 'Mark selected read', exact: true })).toBeDisabled();
	await expect(overflow.getByRole('button', { name: 'Refresh inbox', exact: true })).toBeVisible();
	await expect(overflow.getByRole('button', { name: 'New message', exact: true })).toBeVisible();
	await expect(overflow.getByRole('button', { name: 'Keyboard help', exact: true })).toBeVisible();
	await expect(overflow.getByRole('button', { name: 'Metadata overview', exact: true })).toHaveCount(0);
	await overflow.getByRole('group', { name: 'Presentation', exact: true }).getByRole('radio', { name: 'Activity timeline', exact: true }).check();
	await overflow.getByRole('button', { name: 'Keyboard help', exact: true }).click();
	await expect(overflow).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Interaction help', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('region', { name: 'Interaction help', exact: true })).toHaveCount(0);
	await expect(page.getByRole('list', { name: 'Inbox text list' })).toBeVisible();
	await page.locator('.resource-toolbar').getByRole('button', { name: 'Metadata overview', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Inbox metadata' })).toContainText('7845');
	await expect(page.locator('[data-resource-slot="toolbar.primary.context"]').getByRole("button", { name: "Filter Mailbox: Inbox" })).toBeVisible();
	await page.getByRole("button", { name: "Filter Mailbox: Inbox" }).click();
	await expect(page.getByRole("menuitemradio", { name: /^Archived/ })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.setViewportSize({ width: 2100, height: 900 });
	await expect(page.locator('.resource-toolbar')).toHaveAttribute('data-layout-rows', '1');
	await expect(page.locator('.resource-toolbar')).toHaveAttribute('data-labels', 'full');
	await expect(page.getByRole('heading', { name: 'Inbox triage', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'More Inbox controls', exact: true })).toHaveCount(0);
	const rightGap = await page.locator('[data-toolbar-row="named-primary"]').evaluate((row) =>
		row.getBoundingClientRect().right - row.querySelector('[data-align="end"]')!.getBoundingClientRect().right);
	expect(rightGap).toBeLessThanOrEqual(13);
});
