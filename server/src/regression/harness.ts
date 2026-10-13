/**
 * Test Harness
 * 
 * Creates isolated Coleo instances for regression testing.
 * Each test gets its own database, directories, and ports.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import type { TestContext, TimingHelper, TestResult, TestScenario } from "./types";
import { setEventStore, createTestEventStore } from "../nats/jetstream";

// Re-export utilities from focused modules
export { isPortAvailable, getNextPort } from "./test-ports";
export { createTimingHelper } from "./test-timing";
export { initTestDatabase, setTaskAutoDiscover, startApiServer, startBrain } from "./test-servers";
export { spawnArm, createTask, waitForTaskStatus, waitForArmStatus } from "./test-arm-utils";
export { cleanupTestContext, checkInfraHealth } from "./test-cleanup";

// Import for internal use
import { getNextPort } from "./test-ports";
import { createTimingHelper } from "./test-timing";

/**
 * Create an isolated test context
 */
export async function createTestContext(
  model: { provider: string; model: string },
  options?: { keepAfterTest?: boolean }
): Promise<TestContext> {
  const runId = randomUUID().slice(0, 8);
  const baseDir = join("/tmp", `coleo-regression-${runId}`);
  const coleoDir = join(baseDir, ".coleo");
  const workDir = join(baseDir, "workspace");
  const apiPort = await getNextPort();
  const apiKey = `test-key-${runId}`;

  // Set up in-memory event store for isolated testing
  const testEventStore = createTestEventStore();
  setEventStore(testEventStore);

  // Create directories
  await mkdir(coleoDir, { recursive: true });
  await mkdir(join(coleoDir, "mail", "inbox", "new"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "inbox", "cur"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "inbox", "tmp"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "sent", "new"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "sent", "cur"), { recursive: true });
  await mkdir(join(coleoDir, "mail", "sent", "tmp"), { recursive: true });
  await mkdir(join(coleoDir, "logs"), { recursive: true });
  await mkdir(join(coleoDir, "mcp"), { recursive: true });
  await mkdir(workDir, { recursive: true });

  // Create config file
  const config = `
[brain]
poll_interval_ms = 5000
verbose = true

[api]
port = ${apiPort}
api_key = "${apiKey}"

[model]
provider = "${model.provider}"
model = "${model.model}"
`;
  await writeFile(join(coleoDir, "config.toml"), config);

  const logs: string[] = [];
  const ctx: TestContext = {
    runId,
    coleoDir,
    workDir,
    apiPort,
    apiUrl: `http://localhost:${apiPort}`,
    apiKey,
    model,
    log: (message: string) => {
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] ${message}`;
      logs.push(line);
      console.log(`[${runId}] ${message}`);
    },
    timing: createTimingHelper(),
    processes: [],
    arms: [],
  };

  return ctx;
}

/**
 * Run a single test scenario
 */
export async function runScenario(
  scenario: TestScenario,
  model: { provider: string; model: string },
  options?: { keepOnFailure?: boolean }
): Promise<TestResult> {
  const ctx = await createTestContext(model);
  const startedAt = new Date();
  
  ctx.log(`Starting scenario: ${scenario.name}`);
  ctx.timing.mark("scenario_start");

  let result: TestResult;
  let keepContext = false;

  try {
    // Run setup
    if (scenario.setup) {
      await scenario.setup(ctx);
    }

    // Run the test
    result = await Promise.race([
      scenario.run(ctx),
      new Promise<TestResult>((_, reject) =>
        setTimeout(() => reject(new Error(`Scenario timeout after ${scenario.timeout}ms`)), scenario.timeout)
      ),
    ]);

    // Run evaluation if provided
    if (scenario.evaluate) {
      result = await scenario.evaluate(ctx, result);
    }

    if (!result.passed && options?.keepOnFailure) {
      keepContext = true;
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    ctx.log(`Scenario failed: ${errorMsg}`);
    
    result = {
      runId: ctx.runId,
      scenario: scenario.name,
      passed: false,
      error: errorMsg,
      timing: {
        total: ctx.timing.duration(),
        ...ctx.timing.all(),
      },
      model: ctx.model,
      startedAt,
      endedAt: new Date(),
    };

    if (options?.keepOnFailure) {
      keepContext = true;
    }
  } finally {
    // Run teardown
    if (scenario.teardown) {
      try {
        await scenario.teardown(ctx);
      } catch (error) {
        ctx.log(`Teardown error: ${error}`);
      }
    }

    // Import cleanup dynamically to avoid circular deps
    const { cleanupTestContext } = await import("./test-cleanup");
    await cleanupTestContext(ctx, { keep: keepContext });
  }

  ctx.timing.mark("scenario_end");
  result.timing.total = ctx.timing.duration();
  result.endedAt = new Date();

  ctx.log(`Scenario ${result.passed ? "PASSED" : "FAILED"} in ${result.timing.total}ms`);
  
  return result;
}
