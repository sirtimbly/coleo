/**
 * Browser-regression configuration for critical workbench projections.
 *
 * Tests run against Vite and mock the API at the browser boundary so failures
 * describe presentation regressions rather than local daemon availability.
 */

import { defineConfig, devices } from "@playwright/test";

const webServerCommand = process.env.CI
	? "bun run --cwd src/web preview --host 127.0.0.1 --port 4174"
	: "bun run --cwd src/web dev --host 127.0.0.1 --port 4174";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	workers: 2,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: "http://127.0.0.1:4174",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: webServerCommand,
		url: "http://127.0.0.1:4174",
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
