import { expect, test } from "@playwright/test";
import { installMockApi } from "./support/fixtures";
import type { ViewDefinition } from "../clients/web/src/workbench/types";
import type { Page, Route } from "@playwright/test";

function writeAt<T>(writes: readonly T[], index: number): T {
	const write = writes[index];
	if (write === undefined) throw new Error(`Expected preference write ${index + 1}`);
	return write;
}

async function openConfiguration(page: Page) {
	await page.goto("/tasks");
	await page.getByRole("button", { name: "Configure tasks view: Default", exact: true }).click();
	await expect(page.getByLabel("Row density", { exact: true })).toBeVisible();
}

test("a delayed preference save cannot overtake newer edits or sharing", async ({ page }) => {
	await installMockApi(page);
	const writes: { route: Route; view: ViewDefinition }[] = [];
	await page.route("**/api/workbench/views**", async (route) => {
		const view: ViewDefinition = route.request().postDataJSON();
		writes.push({ route, view });
		if (writes.length > 1) await route.fulfill({ json: { view } });
	});
	await openConfiguration(page);
	await page.getByLabel("Row density", { exact: true }).selectOption("comfortable");
	await expect.poll(() => writes.length).toBe(1);
	await page.getByLabel("Row density", { exact: true }).selectOption("compact");
	await page.getByRole("checkbox", { name: /Share this saved view/ }).check();
	// Cross the debounce boundary while the first response is held.
	await page.waitForTimeout(650);
	expect(writes).toHaveLength(1);
	const first = writeAt(writes, 0);
	await first.route.fulfill({ json: { view: { ...first.view, version: 2 } } });
	await expect(page.getByLabel("Row density", { exact: true })).toHaveValue("compact");
	await expect(page.getByRole("checkbox", { name: /Share this saved view/ })).toBeChecked();
	await expect.poll(() => writes.length).toBe(2);
	expect(writeAt(writes, 1).view.preferences.density).toBe("compact");
	expect(writeAt(writes, 1).view.shared).toBe(true);
	await expect(page.getByText("Saving view preferences…", { exact: true })).toHaveCount(0);
});

test("failed preference saves retain edits and offer a working retry without an unhandled rejection", async ({ page }) => {
	await installMockApi(page);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const writes: ViewDefinition[] = [];
	await page.route("**/api/workbench/views**", async (route) => {
		const view = route.request().postDataJSON();
		writes.push(view);
		await route.fulfill(writes.length === 1
			? { status: 503, json: { error: "Preference service unavailable" } }
			: { json: { view } });
	});
	await openConfiguration(page);
	await page.getByRole("checkbox", { name: /Share this saved view/ }).check();
	const alert = page.getByRole("alert").filter({ hasText: "Could not save" });
	await expect(alert).toBeVisible();
	await expect(page.getByRole("checkbox", { name: /Share this saved view/ })).toBeChecked();
	await page.getByRole("button", { name: "Close configuration", exact: true }).click();
	await alert.getByRole("button", { name: "Retry save" }).click();
	await expect(alert).toHaveCount(0);
	expect(writes).toHaveLength(2);
	expect(writeAt(writes, 1).shared).toBe(true);
	expect(errors).toEqual([]);
});

test("profile and view switches isolate in-flight completions and preserve their own cache", async ({ page }) => {
	test.skip(Boolean(process.env.CI), "Source-module harness requires the Vite development server");
	await installMockApi(page);
	// Replace only the screen: exercise the production provider, hook and HTTP writer.
	await page.route("**/src/pages/DashboardPage.tsx*", async (route) => {
		const source = await (await route.fetch()).text();
		const reactModule = /from ["']([^"']*\/react\.js[^"']*)["']/.exec(source)?.[1];
		if (!reactModule) throw new Error("React module missing");
		await route.fulfill({ contentType: "application/javascript", body: `
			import React from '${reactModule}';
			import {useWorkbenchProfile} from '/src/workbench/profile-context.tsx';
			import {useViewPreferences} from '/src/workbench/use-view-preferences.ts';
			const h = React.createElement;
			export function DashboardPage() {
				const context = useWorkbenchProfile();
				const [id, setId] = React.useState('one');
				const saved = useViewPreferences(id, {id, name:id, kind:'sheet', query:{}, preferences:{density:'compact'}, shared:false});
				return h('div', null,
					h('button', {onClick:()=>context.setActiveProfile(context.profileId === 'local' ? 'reviewer' : 'local')}, 'Switch profile'),
					h('button', {onClick:()=>setId('two')}, 'Switch view'),
					h('button', {onClick:()=>saved.updatePreferences({density:'comfortable'})}, 'Edit preferences'),
					h('output', {'data-testid':'preferences'}, context.profileId + ':' + id + ':' + saved.preferences.density),
					h('output', {'data-testid':'confirmed'}, saved.lastConfirmed.preferences.density),
					h('output', {'data-testid':'cache'}, JSON.stringify(context.views)), saved.saveStatus);
			}` });
	});
	const writes: { route: Route; view: ViewDefinition }[] = [];
	await page.route("**/api/workbench/views**", (route) => {
		writes.push({ route, view: route.request().postDataJSON() });
	});
	await page.goto("/");
	await page.getByRole("button", { name: "Edit preferences" }).click();
	await expect.poll(() => writes.length).toBe(1);
	await page.getByRole("button", { name: "Switch profile" }).click();
	await expect(page.getByTestId("preferences")).toHaveText("reviewer:one:compact");
	await page.getByRole("button", { name: "Edit preferences" }).click();
	await expect.poll(() => writes.length).toBe(2);
	const reviewerWrite = writeAt(writes, 1);
	await reviewerWrite.route.fulfill({ json: { view: reviewerWrite.view } });
	await expect(page.getByTestId("confirmed")).toHaveText("comfortable");
	const localWrite = writeAt(writes, 0);
	await localWrite.route.fulfill({ json: { view: localWrite.view } });
	await expect(page.getByTestId("cache")).not.toContainText('"profileId":"local"');
	await page.getByRole("button", { name: "Edit preferences" }).click();
	await expect.poll(() => writes.length).toBe(3);
	await page.getByRole("button", { name: "Switch view" }).click();
	await writeAt(writes, 2).route.fulfill({ status: 503, json: { error: "Old view failed" } });
	await expect(page.getByTestId("preferences")).toHaveText("reviewer:two:compact");
	await expect(page.getByTestId("confirmed")).toHaveText("compact");
	await expect(page.getByRole("button", { name: "Retry save" })).toHaveCount(0);
	await page.getByRole("button", { name: "Switch profile" }).click();
	await expect(page.getByTestId("cache")).toContainText('"profileId":"local"');
	expect(writes.map(({ view }) => view.profileId)).toEqual(["local", "reviewer", "reviewer"]);
});
