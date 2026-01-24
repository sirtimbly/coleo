import { tool } from "@opencode-ai/plugin";

/**
 * Test runner tools for Octopai
 * 
 * Wraps the various test commands in package.json scripts.
 */

export const unit = tool({
  description: `Run unit tests.

Runs all unit tests in src/**/__tests__/ using Bun's test runner.
Returns the test output including pass/fail status.`,
  args: {
    filter: tool.schema.string().optional().describe("Filter tests by name pattern"),
  },
  async execute(args) {
    try {
      const filterArg = args.filter ? `--test-name-pattern "${args.filter}"` : "";
      const result = await Bun.$`bun test src/**/__tests__/ ${filterArg} 2>&1`.text();
      return result;
    } catch (err: any) {
      // Test failures return non-zero exit code
      return err.stdout?.toString() || err.message || "Test run failed";
    }
  },
});

export const unit_watch = tool({
  description: `Start unit tests in watch mode.

Runs tests and re-runs on file changes. 
Note: This runs in foreground - use Ctrl+C to stop.`,
  args: {},
  async execute() {
    return "Watch mode should be run directly in terminal: bun test --watch src/**/__tests__/";
  },
});

export const integration = tool({
  description: `Run integration tests (quick mode).

Runs the regression test suite with --quick flag for faster execution.
Tests harness spawning, API endpoints, and arm lifecycle.`,
  args: {},
  async execute() {
    try {
      const result = await Bun.$`bun run src/regression/runner.ts --quick 2>&1`.text();
      return result;
    } catch (err: any) {
      return err.stdout?.toString() || err.message || "Integration tests failed";
    }
  },
});

export const e2e = tool({
  description: `Run full end-to-end tests.

Runs the complete regression test suite including all scenarios.
This takes longer than integration tests.`,
  args: {},
  async execute() {
    try {
      const result = await Bun.$`bun run src/regression/runner.ts 2>&1`.text();
      return result;
    } catch (err: any) {
      return err.stdout?.toString() || err.message || "E2E tests failed";
    }
  },
});

export const typecheck = tool({
  description: `Run TypeScript type checking.

Runs 'tsc --noEmit' to check for type errors without emitting files.
Returns any type errors found or confirms success.`,
  args: {},
  async execute() {
    try {
      const result = await Bun.$`bun run typecheck 2>&1`.text();
      if (result.trim().length === 0) {
        return "TypeScript: No errors found ✓";
      }
      return result;
    } catch (err: any) {
      return err.stdout?.toString() || err.message || "Typecheck failed";
    }
  },
});

export const build = tool({
  description: `Build the Octopai CLI for distribution.

Runs the build script to create the dist/ output.`,
  args: {},
  async execute() {
    try {
      const result = await Bun.$`bun run build 2>&1`.text();
      return result || "Build completed successfully";
    } catch (err: any) {
      return err.stdout?.toString() || err.message || "Build failed";
    }
  },
});

export const web_build = tool({
  description: `Build the Web UI for production.

Runs the Vite build for the React dashboard.
Output goes to src/web/dist/`,
  args: {},
  async execute() {
    try {
      const result = await Bun.$`bun run web:build 2>&1`.text();
      return result || "Web build completed successfully";
    } catch (err: any) {
      return err.stdout?.toString() || err.message || "Web build failed";
    }
  },
});
