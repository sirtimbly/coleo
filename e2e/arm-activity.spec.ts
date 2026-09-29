import { expect, test } from "@playwright/test";

import { installMockApi } from "./support/fixtures";

const arm = {
	id: "arm-octavia",
	name: "Octavia",
	status: "busy",
	harness: "opencode-api",
	provider: "openai",
	model: "gpt-5",
	contextBudget: 128000,
	currentContextUsed: 24000,
	createdAt: "2026-08-02T11:00:00.000Z",
	updatedAt: "2026-08-02T12:00:00.000Z",
};

function telemetryPayload() {
	const end = Date.now();
	const minute = 60_000;
	const at = (minutesAgo: number) =>
		new Date(end - minutesAgo * minute).toISOString();
	return {
		window: {
			start: new Date(end - 30 * minute).toISOString(),
			end: new Date(end).toISOString(),
			bucketMs: minute,
		},
		armCount: 1,
		activity: {
			buckets: [
				{
					start: at(29),
					counts: { write: 3, think: 0, tool: 0, complete: 0 },
				},
				{
					start: at(15),
					counts: { write: 0, think: 2, tool: 4, complete: 0 },
				},
				{
					start: at(2),
					counts: { write: 0, think: 0, tool: 0, complete: 2 },
				},
			],
			summary: { totalEvents: 11, lastEventAt: at(2) },
		},
		contextSamples: [],
		costSamples: [],
	};
}

test("fleet telemetry renders the activity chart with per-category segments", async ({
	page,
}) => {
	await installMockApi(page, { arms: [arm] });
	await page.route("**/api/events/telemetry*", (route) =>
		route.fulfill({ json: telemetryPayload() }),
	);
	await page.goto("/arms");

	const chart = page.getByRole("heading", { name: "Activity - All Arms" });
	await expect(chart).toBeVisible();

	// Legend covers all four spec categories.
	for (const label of [
		"File writes",
		"Thinking / reasoning",
		"Tool calls",
		"Completed tasks",
	]) {
		await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
	}

	// One stacked segment per category color: blue writes, yellow
	// thinking, green tools, prominent purple completions.
	const svg = page.locator('svg[aria-label^="Arm activity"]').first();
	await expect(svg).toBeVisible();
	for (const color of ["#3b82f6", "#eab308", "#22c55e", "#a855f7"]) {
		await expect(
			svg.locator(`rect[fill="${color}"]`).first(),
		).toBeAttached();
	}
});
