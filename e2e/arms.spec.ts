/**
 * Browser protection for the Arm fleet and its handoff to the live Viewer.
 */

import { expect, test } from "@playwright/test";

import { installMockApi } from "./support/fixtures";

import type { Page } from "@playwright/test";

async function installMissingArmCatalog(page: Page) {
	await installMockApi(page);
	await page.route("**/api/agents", (route) => route.fulfill({ json: {
		agents: [{ agentId: "test-host", hostname: "Test host", capabilities: ["opencode-api", "opencode-provider-auth"] }],
	} }));
	await page.route("**/api/opencode/providers", (route) => route.fulfill({ json: {
		providers: [], connected: [], source: "fallback",
	} }));
}

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

	await expect(page.getByRole("toolbar", { name: "Arm fleet controls" })).toBeVisible();
	const octaviaRow = page.locator('div[role="button"]', {
		has: page.getByText(activeArm.name, { exact: true }),
	});
	await expect(octaviaRow).toBeVisible();
	await expect(octaviaRow).toContainText("Task · Unify the workbench");
	await expect(page.getByRole("button", { name: "Spawn arm", exact: true })).toBeVisible();
});

test("opens the selected Arm in the dedicated Viewer route", async ({ page }) => {
	await installMockApi(page, { arms: [activeArm] });
	await page.goto("/arms");
	await expect(page.getByRole("link", { name: "Viewer", exact: true })).toHaveCount(0);
	const octaviaRow = page.locator('div[role="button"]', {
		has: page.getByText(activeArm.name, { exact: true }),
	});
	await expect(octaviaRow).toBeVisible();
	await octaviaRow.click();

	await expect(page).toHaveURL(/\/viewer\?arm=arm-octavia/);
	await expect(page.getByRole("heading", { name: /Octavia/ })).toBeVisible();
});

test("refreshes a missing arm catalog after a host failure without resetting the form", async ({ page }) => {
	await installMissingArmCatalog(page);
	let requests = 0;
	let releaseRefresh = () => {};
	const refreshReady = new Promise<void>((resolve) => { releaseRefresh = resolve; });
	await page.route("**/api/opencode/agents/test-host/providers", async (route) => {
		requests++;
		if (requests === 1) {
			await route.fulfill({ status: 502, json: { error: "Arm host is temporarily unavailable" } });
			return;
		}
		await refreshReady;
		await route.fulfill({ json: { providers: [{
			id: "openai", name: "OpenAI", connected: true,
			models: [{ id: "gpt-5", name: "GPT-5" }],
		}] } });
	});
	await page.goto("/arms?spawn=1");
	const refresh = page.getByRole("button", { name: "Refresh providers and models" });
	await expect(page.getByRole("status", { name: "Provider status" })).toContainText("Arm host is temporarily unavailable");
	await expect(refresh).toBeEnabled();
	await page.getByLabel("Arm name", { exact: true }).fill("My new arm");
	await refresh.click();
	await expect(refresh).toBeDisabled();
	await expect(page.getByRole("status", { name: "Provider status" })).toContainText("Loading providers and models");
	releaseRefresh();
	await expect(page.locator(".spawn-arm-panel__runtime select")).toHaveCount(3);
	await expect(page.locator(".spawn-arm-panel__runtime select").nth(1)).toHaveValue("openai");
	await expect(page.locator(".spawn-arm-panel__runtime select").nth(2)).toHaveValue("gpt-5");
	await expect(refresh).toHaveCount(0);
	await expect(page.getByLabel("Arm name", { exact: true })).toHaveValue("My new arm");
	expect(requests).toBe(2);
});

test("keeps refresh available when the arm host returns an empty catalog", async ({ page }) => {
	await installMissingArmCatalog(page);
	await page.route("**/api/opencode/agents/test-host/providers", (route) =>
		route.fulfill({ json: { providers: [] } }),
	);
	await page.goto("/arms?spawn=1");
	const refresh = page.getByRole("button", { name: "Refresh providers and models" });
	await expect(refresh).toBeEnabled();
	await expect(page.getByRole("status", { name: "Provider status" })).toContainText("No providers or models are available");
	await refresh.click();
	await expect(refresh).toBeEnabled();
	await expect(page.locator(".spawn-arm-panel__runtime input")).toHaveCount(2);
});

const testHost = {
	agentId: "test-host", hostname: "Test host",
	capabilities: ["opencode-api", "workspace-rpc", "repository-onboarding", "opencode-provider-auth"],
};
const testProviders = [{
	id: "openai", name: "OpenAI", connected: true,
	models: [{ id: "gpt-5", name: "GPT-5" }],
}];

test("puts the missing host first and discovers a host without reopening the panel", async ({ page }) => {
	await installMockApi(page);
	let connected = false;
	await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: connected ? [testHost] : [] } }));
	await page.route("**/api/opencode/agents/test-host/providers", (route) => route.fulfill({ json: { providers: testProviders } }));
	await page.goto("/arms?spawn=1");
	await expect(page.getByRole("heading", { name: "No arm host connected" })).toBeVisible();
	await expect(page.getByText("coleo agent start", { exact: true })).toBeVisible();
	await expect(page.getByLabel("Provider", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Model estimate*", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Refresh providers and models" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Spawn Arm", exact: true })).toBeDisabled();
	connected = true;
	await page.getByRole("button", { name: "Check for hosts" }).click();
	await expect(page.getByRole("heading", { name: "Arm host connected", exact: true })).toBeVisible();
	await expect(page.getByLabel("Harness", { exact: true }).locator("option")).toHaveText(["opencode-api"]);
	await expect(page.getByRole("button", { name: "Spawn Arm", exact: true })).toBeEnabled();
});

test("distinguishes loading and host lookup errors from an offline host", async ({ page }) => {
	await installMockApi(page);
	let releaseLookup = () => {};
	const lookupReady = new Promise<void>((resolve) => { releaseLookup = resolve; });
	let fail = true;
	await page.route("**/api/agents", async (route) => {
		await lookupReady;
		await route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: "Host service unavailable" } : { agents: [] } });
	});
	await page.goto("/arms?spawn=1");
	await expect(page.getByRole("heading", { name: "Checking arm hosts…" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "No arm host connected" })).toHaveCount(0);
	releaseLookup();
	await expect(page.getByRole("heading", { name: "Could not check arm hosts" })).toBeVisible();
	await expect(page.getByText("Host service unavailable", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Spawn Arm", exact: true })).toBeDisabled();
	fail = false;
	await page.getByRole("button", { name: "Check for hosts" }).click();
	await expect(page.getByRole("heading", { name: "No arm host connected" })).toBeVisible();
});

test("automatically detects a host disconnect and preserves the form through recovery", async ({ page }) => {
	await installMockApi(page);
	await page.clock.install();
	let connected = true;
	await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: connected ? [testHost] : [] } }));
	await page.route("**/api/opencode/agents/test-host/providers", (route) => route.fulfill({ json: { providers: testProviders } }));
	await page.goto("/arms?spawn=1");
	await page.getByLabel("Arm name", { exact: true }).fill("Keep this name");
	await expect(page.getByRole("button", { name: "Spawn Arm", exact: true })).toBeEnabled();
	connected = false;
	await page.clock.fastForward(10_000);
	await expect(page.getByRole("heading", { name: "Selected arm host disconnected" })).toBeVisible();
	await expect(page.getByLabel("Provider", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Spawn Arm", exact: true })).toBeDisabled();
	connected = true;
	await page.clock.fastForward(10_000);
	await expect(page.getByLabel("Arm name", { exact: true })).toHaveValue("Keep this name");
	await expect(page.getByLabel("Model", { exact: true })).toHaveValue("gpt-5");
	await expect(page.getByRole("button", { name: "Spawn Arm", exact: true })).toBeEnabled();
});

test("blocks a host with only service capabilities instead of offering them as harnesses", async ({ page }) => {
	await installMockApi(page);
	await page.route("**/api/agents", (route) => route.fulfill({ json: {
		agents: [{ ...testHost, capabilities: ["workspace-rpc", "repository-onboarding", "opencode-provider-auth"] }],
	} }));
	await page.goto("/arms?spawn=1");
	await expect(page.getByRole("heading", { name: "This host has no supported harnesses" })).toBeVisible();
	await expect(page.getByLabel("Harness", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Spawn Arm", exact: true })).toBeDisabled();
});

test("ignores the previous host catalog when switching hosts and explains required provider setup", async ({ page }) => {
	await installMockApi(page);
	await page.route("**/api/agents", (route) => route.fulfill({ json: {
		agents: [testHost, { ...testHost, agentId: "second-host", hostname: "Second host" }],
	} }));
	let releaseFirst = () => {};
	const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
	await page.route("**/api/opencode/agents/test-host/providers", async (route) => {
		await firstReady;
		await route.fulfill({ json: { providers: testProviders } });
	});
	await page.route("**/api/opencode/agents/second-host/providers", (route) => route.fulfill({ json: {
		providers: [{ id: "anthropic", name: "Anthropic", connected: false, models: [{ id: "claude", name: "Claude" }] }],
	} }));
	await page.goto("/arms?spawn=1");
	await expect(page.getByRole("status", { name: "Provider status" })).toContainText("Loading providers");
	await page.getByLabel("Arm host", { exact: true }).selectOption("second-host");
	await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("anthropic");
	const oldResponse = page.waitForResponse("**/api/opencode/agents/test-host/providers");
	releaseFirst();
	await oldResponse;
	await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("anthropic");
	await expect(page.getByText("Anthropic needs to be connected on Second host before spawning.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Set up", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Spawn Arm", exact: true })).toBeDisabled();
});

test("shows spawning progress and an actionable failure while keeping the entered name", async ({ page }) => {
	await installMissingArmCatalog(page);
	await page.route("**/api/opencode/agents/test-host/providers", (route) => route.fulfill({ json: { providers: testProviders } }));
	let releaseSpawn = () => {};
	const spawnReady = new Promise<void>((resolve) => { releaseSpawn = resolve; });
	await page.route("**/api/arms/*/spawn", async (route) => {
		await spawnReady;
		await route.fulfill({ status: 502, json: { error: "The arm host could not start this arm. Try again." } });
	});
	await page.goto("/arms?spawn=1");
	await page.getByLabel("Arm name", { exact: true }).fill("retry-arm");
	await page.getByRole("button", { name: "Spawn Arm", exact: true }).click();
	await expect(page.getByRole("button", { name: "Starting...", exact: true })).toBeDisabled();
	await expect(page.getByLabel("Arm name", { exact: true })).toBeDisabled();
	await expect(page.getByLabel("Arm host", { exact: true })).toBeDisabled();
	releaseSpawn();
	await expect(page.locator(".spawn-arm-panel").getByRole("alert")).toContainText("The arm host could not start this arm. Try again.");
	await expect(page.getByLabel("Arm name", { exact: true })).toHaveValue("retry-arm");
	await expect(page.getByRole("button", { name: "Spawn Arm", exact: true })).toBeEnabled();
});
