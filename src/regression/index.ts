/**
 * Octopai Regression Test Suite
 * 
 * Automated testing for core Octopai scenarios:
 * - Infrastructure startup and health
 * - Self-healing after failures
 * - Arm spawning and task completion
 * - Zombie arm detection
 * 
 * Usage:
 *   bun run src/regression/runner.ts --help
 * 
 * Quick test:
 *   bun run src/regression/runner.ts --quick
 * 
 * Full suite:
 *   bun run src/regression/runner.ts
 * 
 * Compare models:
 *   bun run src/regression/runner.ts --model openai/gpt-5.1-codex-mini --model openai/gpt-4o
 */

export * from "./types";
export * from "./harness";
export * from "./scenarios";
export { runTestSuite, main } from "./runner";
