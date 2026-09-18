import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/fixtures";
import type { Page, Route } from "@playwright/test";

// These source-module fault injections require the development server.
test.skip(Boolean(process.env.CI), "The CI preview server serves bundled screens, not replaceable source modules");

async function replaceScreen(route: Route, body: string) {
	const original = await route.fetch();
	const source = await original.text();
	const reactModule = /from ["']([^"']*\/react\.js[^"']*)["']/.exec(source)?.[1];
	if (!reactModule) throw new Error("Could not identify the screen's React module");
	await route.fulfill({ contentType: "application/javascript", body: body.replace("REACT_MODULE", reactModule) });
}

// Replace only screen modules in the test browser; production code has no crash switches.
async function installScreens(page: Page) {
	await installMockApi(page);
	await page.route("**/src/pages/DashboardPage.tsx*", (route) => replaceScreen(route, `import React from 'REACT_MODULE'; const {createElement: h, useState} = React;
		import { useWorkspaceOpenRoute } from '/src/workspace/route-context.tsx';
		export function DashboardPage() {
			const [count, setCount] = useState(0);
			const open = useWorkspaceOpenRoute();
			return h('div', null,
				h('button', {onClick: () => setCount(count + 1)}, 'Healthy count: ' + count),
				h('button', {onClick: () => open({pathname: '/settings', search: ''}, 'split')}, 'Open sibling screen'));
		}`));
	await page.route("**/src/pages/SettingsPage.tsx*", (route) => replaceScreen(route, `import React from 'REACT_MODULE'; const {createElement: h, useState} = React;
		export function SettingsPage() {
			const [failed, setFailed] = useState(false);
			if (failed) throw new Error('Intentional screen render failure');
			return h('button', {onClick: () => setFailed(true)}, 'Crash this screen');
		}`));
}

test("Golden Layout isolates a crashed tab, retries it locally, and keeps sibling state", async ({ page }) => {
	await installScreens(page);
	await page.addInitScript(() => localStorage.setItem("coleo-layout-mode", "golden"));
	await page.goto("/");
	await page.getByRole("button", { name: "Open sibling screen" }).click();
	await page.getByRole("button", { name: "Crash this screen" }).waitFor();
	await page.getByRole("button", { name: "Healthy count: 0" }).click();
	await page.getByRole("button", { name: "Crash this screen" }).click();
	const failed = page.getByRole("alert", { name: /failed$/ });
	await expect(failed).toBeVisible();
	await expect(page.locator(".lm_tab")).toHaveCount(2);
	await page.getByRole("button", { name: "Healthy count: 1" }).click();
	await expect(page.getByRole("button", { name: "Healthy count: 2" })).toBeVisible();
	await failed.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByRole("button", { name: "Crash this screen" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Healthy count: 2" })).toBeVisible();
	await page.getByRole("button", { name: "Crash this screen" }).click();
	await failed.getByRole("button", { name: "Close tab" }).click();
	await expect(page.locator(".lm_tab")).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Healthy count: 2" })).toBeVisible();
});

test("a standalone screen failure preserves navigation and resets on a new route", async ({ page }) => {
	await installScreens(page);
	await page.goto("/settings");
	await page.getByRole("button", { name: "Crash this screen" }).click();
	await expect(page.getByRole("alert", { name: "this screen failed" })).toBeVisible();
	await page.getByRole("link", { name: "Dashboard", exact: true }).click();
	await expect(page.getByRole("button", { name: "Healthy count: 0" })).toBeVisible();
	await expect(page.getByRole("alert", { name: "this screen failed" })).toHaveCount(0);
});

test("a failed expanded card stays local to its grid row", async ({ page }) => {
	await installMockApi(page, { activity: [{ id: "one", sequence: 1, timestamp: "2026-09-18T12:00:00Z",
		actor: "brain", action: "poll_completed", target: null, details: {} }] });
	await page.route("**/src/adaptive-cards/AdaptiveCardView.tsx*", (route) => route.fulfill({
		contentType: "application/javascript",
		body: `export function AdaptiveCardView() { throw new Error('Intentional card failure'); }
		export const DeferredAdaptiveCardView = AdaptiveCardView;`,
	}));
	await page.goto("/messaging?facet=all");
	const row = page.locator('[data-inbox-item-id="activity:one"]');
	await row.getByRole("button", { name: "Expand Poll completed card" }).click();
	await expect(row.getByRole("alert", { name: "this card failed" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
	await row.getByRole("button", { name: "Collapse Poll completed card" }).click();
	await expect(row.getByRole("alert")).toHaveCount(0);
});
