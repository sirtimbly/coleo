/**
 * Core Regression Test Scenarios
 * 
 * Tests the most fundamental Coleo operations:
 * 1. Infrastructure startup and health
 * 2. Self-healing after failures
 * 3. Arm spawning and task completion
 */

import type { TestScenario, TestContext, TestResult } from "./types";
import {
  initTestDatabase,
  startApiServer,
  startBrain,
  spawnArm,
  createTask,
  waitForTaskStatus,
  waitForArmStatus,
  checkInfraHealth,
} from "./harness";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";

/**
 * Scenario 1: Infrastructure Startup
 * 
 * Tests that all infrastructure components can start up correctly.
 * - Database initializes
 * - API server starts and responds to health checks
 * - Brain can run a poll cycle
 */
export const infrastructureStartup: TestScenario = {
  name: "infrastructure-startup",
  description: "Verify all infrastructure components start correctly",
  tags: ["core", "infrastructure", "quick"],
  timeout: 30000,

  async run(ctx: TestContext): Promise<TestResult> {
    const checks: Array<{ name: string; passed: boolean; details?: string }> = [];

    // Step 1: Initialize database
    ctx.timing.mark("db_init_start");
    try {
      await initTestDatabase(ctx);
      ctx.timing.mark("db_init_done");
      checks.push({ name: "database_init", passed: true });
    } catch (error) {
      checks.push({ name: "database_init", passed: false, details: String(error) });
      return createFailedResult(ctx, "Database initialization failed", checks);
    }

    // Step 2: Start API server
    ctx.timing.mark("api_init_start");
    try {
      await startApiServer(ctx);
      ctx.timing.mark("api_init_done");
      checks.push({ name: "api_server_start", passed: true });
    } catch (error) {
      checks.push({ name: "api_server_start", passed: false, details: String(error) });
      return createFailedResult(ctx, "API server failed to start", checks);
    }

    // Step 3: Verify API health endpoint
    try {
      const healthy = await checkInfraHealth(ctx);
      checks.push({ name: "api_health_check", passed: healthy });
      if (!healthy) {
        return createFailedResult(ctx, "API health check failed", checks);
      }
    } catch (error) {
      checks.push({ name: "api_health_check", passed: false, details: String(error) });
      return createFailedResult(ctx, "API health check threw error", checks);
    }

    // Step 4: Run brain once
    ctx.timing.mark("brain_start");
    try {
      const brainProc = await startBrain(ctx, { once: true });
      const exitCode = await brainProc.exited;
      ctx.timing.mark("brain_done");
      
      checks.push({ 
        name: "brain_poll_cycle", 
        passed: exitCode === 0,
        details: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined
      });
      
      if (exitCode !== 0) {
        return createFailedResult(ctx, `Brain exited with code ${exitCode}`, checks);
      }
    } catch (error) {
      checks.push({ name: "brain_poll_cycle", passed: false, details: String(error) });
      return createFailedResult(ctx, "Brain failed to run", checks);
    }

    return {
      runId: ctx.runId,
      scenario: "infrastructure-startup",
      passed: true,
      timing: {
        total: ctx.timing.duration(),
        infraStartup: ctx.timing.duration("db_init_start", "api_init_done"),
        brainHealthy: ctx.timing.duration("brain_start", "brain_done"),
      },
      quality: {
        outputCorrect: true,
        score: 100,
        checks,
      },
      model: ctx.model,
      startedAt: new Date(Date.now() - ctx.timing.duration()),
      endedAt: new Date(),
    };
  },
};

/**
 * Scenario 2: Self-Healing After API Restart
 * 
 * Tests that the brain can detect and recover from API server restart.
 * - Start infrastructure normally
 * - Kill API server
 * - Brain detects unhealthy state
 * - Restart API server
 * - Brain recovers and continues
 */
export const selfHealingApiRestart: TestScenario = {
  name: "self-healing-api-restart",
  description: "Verify brain detects and recovers from API server restart",
  tags: ["core", "resilience", "self-healing"],
  timeout: 60000,

  async run(ctx: TestContext): Promise<TestResult> {
    const checks: Array<{ name: string; passed: boolean; details?: string }> = [];

    // Setup infrastructure
    await initTestDatabase(ctx);
    await startApiServer(ctx);
    checks.push({ name: "initial_setup", passed: true });

    // Verify initial health
    let healthy = await checkInfraHealth(ctx);
    checks.push({ name: "initial_health", passed: healthy });
    if (!healthy) {
      return createFailedResult(ctx, "Initial health check failed", checks);
    }

    // Kill API server
    ctx.timing.mark("api_kill");
    const apiProcess = ctx.processes.find(p => p.name === "api-server");
    if (apiProcess) {
      apiProcess.kill();
      ctx.log("API server killed");
    }

    // Wait for health check to fail
    await Bun.sleep(500);
    healthy = await checkInfraHealth(ctx);
    checks.push({ name: "unhealthy_detected", passed: !healthy });
    if (healthy) {
      return createFailedResult(ctx, "API should be unhealthy after kill", checks);
    }
    ctx.timing.mark("unhealthy_detected");

    // Restart API server
    ctx.timing.mark("api_restart");
    await startApiServer(ctx);
    ctx.timing.mark("api_restarted");

    // Verify recovery
    healthy = await checkInfraHealth(ctx);
    checks.push({ name: "recovery_health", passed: healthy });
    if (!healthy) {
      return createFailedResult(ctx, "API health check failed after restart", checks);
    }

    // Run brain to verify it works after recovery
    const brainProc = await startBrain(ctx, { once: true });
    const exitCode = await brainProc.exited;
    checks.push({ name: "brain_after_recovery", passed: exitCode === 0 });

    return {
      runId: ctx.runId,
      scenario: "self-healing-api-restart",
      passed: exitCode === 0,
      timing: {
        total: ctx.timing.duration(),
        infraStartup: ctx.timing.duration("_start", "api_kill"),
      },
      quality: {
        outputCorrect: true,
        score: exitCode === 0 ? 100 : 0,
        checks,
      },
      model: ctx.model,
      startedAt: new Date(Date.now() - ctx.timing.duration()),
      endedAt: new Date(),
    };
  },
};

/**
 * Scenario 3: Simple Task Completion
 * 
 * The core e2e test: spawn an arm and have it complete a simple task.
 * - Create a simple file modification task
 * - Spawn an arm
 * - Brain assigns task to arm
 * - Arm claims and completes task
 * - Verify output quality
 */
export const simpleTaskCompletion: TestScenario = {
  name: "simple-task-completion",
  description: "Spawn arm, assign task, verify completion",
  tags: ["core", "e2e", "task"],
  timeout: 240000, // 4 minutes for full task completion

  async setup(ctx: TestContext): Promise<void> {
    // Create a simple file for the task to modify
    await mkdir(join(ctx.workDir, "src"), { recursive: true });
    await writeFile(
      join(ctx.workDir, "src", "hello.ts"),
      `// Simple hello world\nexport function hello(): string {\n  return "Hello";\n}\n`
    );
    
    // Create a minimal package.json
    await writeFile(
      join(ctx.workDir, "package.json"),
      JSON.stringify({ name: "test-project", version: "1.0.0" }, null, 2)
    );
  },

  async run(ctx: TestContext): Promise<TestResult> {
    const checks: Array<{ name: string; passed: boolean; details?: string }> = [];

    // Setup infrastructure
    await initTestDatabase(ctx);
    await startApiServer(ctx);
    checks.push({ name: "infrastructure_ready", passed: true });

    // Create a simple task
    ctx.timing.mark("task_create");
    const taskId = await createTask(
      ctx,
      "Add a name parameter to the hello function",
      `Modify the file src/hello.ts to:
1. Add a 'name' parameter to the hello function
2. Return "Hello, {name}!" instead of just "Hello"
3. Make the parameter optional with a default value of "World"

The file is located at: ${join(ctx.workDir, "src", "hello.ts")}

When done, mark the task as completed.`,
      { priority: 'high' }
    );
    checks.push({ name: "task_created", passed: true });

    // Start brain in background
    const brainProc = await startBrain(ctx);
    checks.push({ name: "brain_started", passed: true });

    // Wait a moment for brain to initialize
    await Bun.sleep(2000);

    // Spawn an arm
    ctx.timing.mark("arm_spawn");
    let armId: string;
    try {
      const arm = await spawnArm(ctx, "test-arm", {
        domain: "general",
        // The system prompt already tells arms to immediately get tasks
        // We just provide context about the workspace
        prompt: `You are working in a test workspace at ${ctx.workDir}.
The task involves modifying src/hello.ts. Start by calling 'get_full_briefing' to see the task, then call 'claim_task' with the task ID to claim it.`,
      });
      armId = arm.id;
      checks.push({ name: "arm_spawned", passed: true });
    } catch (error) {
      checks.push({ name: "arm_spawned", passed: false, details: String(error) });
      return createFailedResult(ctx, "Failed to spawn arm", checks);
    }

    // Wait for task to be claimed
    ctx.timing.mark("wait_claim");
    // Allow 'completed' as well, in case it finishes extremely fast (race condition)
    const claimed = await waitForTaskStatus(ctx, taskId, ["claimed", "completed"], 60000);
    ctx.timing.mark("task_claimed");
    checks.push({ name: "task_claimed", passed: claimed });
    if (!claimed) {
      return createFailedResult(ctx, "Task was not claimed within timeout", checks);
    }

    // Wait for task completion
    ctx.timing.mark("wait_complete");
    let completed = await waitForTaskStatus(ctx, taskId, "completed", 150000);
    ctx.timing.mark("task_completed");
    checks.push({ name: "task_completed", passed: completed });
    if (!completed && armId) {
      try {
        await fetch(`${ctx.apiUrl}/api/arms/${armId}/reset-session`, {
          method: "POST",
          headers: { "X-API-Key": ctx.apiKey },
        });
        await fetch(`${ctx.apiUrl}/api/arms/${armId}/prompt`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": ctx.apiKey,
          },
          body: JSON.stringify({
            prompt: `Please complete task ${taskId} now. Steps: 1) Open src/hello.ts in ${ctx.workDir}. 2) Add optional name param defaulting to "World". 3) Return "Hello, {name}!". 4) Call complete_task with a summary.`,
          }),
        });
        completed = await waitForTaskStatus(ctx, taskId, "completed", 60000);
        checks.push({ name: "task_completed_after_prompt", passed: completed });
      } catch (error) {
        checks.push({ name: "task_prompt_failed", passed: false, details: String(error) });
      }
    }
    if (!completed) {
      return createFailedResult(ctx, "Task was not completed within timeout", checks);
    }

    // Verify the file was modified correctly
    ctx.timing.mark("verify_output");
    let outputCorrect = false;
    let qualityScore = 0;

    try {
      const content = await readFile(join(ctx.workDir, "src", "hello.ts"), "utf-8");
      
      // Check for expected changes
      const hasNameParam = content.includes("name");
      const hasDefaultValue = content.includes("World") || content.includes("=");
      const hasTemplate = content.includes("Hello,") || content.includes("${name}") || content.includes("+ name");
      
      checks.push({ name: "has_name_param", passed: hasNameParam, details: hasNameParam ? undefined : "Missing name parameter" });
      checks.push({ name: "has_default_value", passed: hasDefaultValue, details: hasDefaultValue ? undefined : "Missing default value" });
      checks.push({ name: "has_template", passed: hasTemplate, details: hasTemplate ? undefined : "Missing string template" });

      // Calculate quality score
      qualityScore = [hasNameParam, hasDefaultValue, hasTemplate].filter(Boolean).length * 33;
      if (qualityScore >= 99) qualityScore = 100;
      
      outputCorrect = hasNameParam && hasDefaultValue && hasTemplate;
    } catch (error) {
      checks.push({ name: "file_readable", passed: false, details: String(error) });
    }

    // Kill brain
    brainProc.kill();

    return {
      runId: ctx.runId,
      scenario: "simple-task-completion",
      passed: completed && outputCorrect,
      timing: {
        total: ctx.timing.duration(),
        infraStartup: ctx.timing.duration("_start", "task_create"),
        armSpawn: ctx.timing.duration("arm_spawn", "task_claimed"),
        taskClaimed: ctx.timing.duration("task_create", "task_claimed"),
        taskCompleted: ctx.timing.duration("task_claimed", "task_completed"),
      },
      quality: {
        outputCorrect,
        score: qualityScore,
        checks,
      },
      model: ctx.model,
      startedAt: new Date(Date.now() - ctx.timing.duration()),
      endedAt: new Date(),
    };
  },
};

/**
 * Scenario 4: Zombie Arm Detection
 * 
 * Tests that the brain can detect and handle unresponsive arms.
 * - Create an arm entry in database with stale PID
 * - Run brain poll cycle
 * - Verify arm is marked as stopped
 */
export const zombieArmDetection: TestScenario = {
  name: "zombie-arm-detection",
  description: "Verify brain detects and cleans up zombie arms",
  tags: ["core", "resilience", "zombie"],
  timeout: 30000,

  async run(ctx: TestContext): Promise<TestResult> {
    const checks: Array<{ name: string; passed: boolean; details?: string }> = [];

    // Setup infrastructure
    await initTestDatabase(ctx);
    await startApiServer(ctx);
    checks.push({ name: "infrastructure_ready", passed: true });

    // Insert a fake arm with a dead PID
    const fakeArmId = "zombie-arm-" + ctx.runId;
    const deadPid = 99999; // Very unlikely to be a real process
    const now = new Date().toISOString();

    ctx.db!.run(`
      INSERT INTO arms (id, name, status, harness, pid, domain, created_at, updated_at)
      VALUES (?, ?, 'busy', 'opencode-api', ?, 'general', ?, ?)
    `, [fakeArmId, fakeArmId, deadPid, now, now]);
    
    checks.push({ name: "zombie_arm_created", passed: true });
    ctx.log(`Created zombie arm with dead PID ${deadPid}`);

    // Run brain once
    ctx.timing.mark("brain_start");
    const brainProc = await startBrain(ctx, { once: true });
    await brainProc.exited;
    ctx.timing.mark("brain_done");
    checks.push({ name: "brain_poll_complete", passed: true });

    // Check if arm was marked as stopped
    const row = ctx.db!.query("SELECT status FROM arms WHERE id = ?").get(fakeArmId) as { status: string } | null;
    const armStopped = row?.status === "stopped";
    checks.push({ name: "zombie_detected", passed: armStopped, details: `Status: ${row?.status}` });

    return {
      runId: ctx.runId,
      scenario: "zombie-arm-detection",
      passed: armStopped,
      timing: {
        total: ctx.timing.duration(),
        brainHealthy: ctx.timing.duration("brain_start", "brain_done"),
      },
      quality: {
        outputCorrect: armStopped,
        score: armStopped ? 100 : 0,
        checks,
      },
      model: ctx.model,
      startedAt: new Date(Date.now() - ctx.timing.duration()),
      endedAt: new Date(),
    };
  },
};

/**
 * Helper to create a failed result
 */
function createFailedResult(
  ctx: TestContext,
  error: string,
  checks: Array<{ name: string; passed: boolean; details?: string }>
): TestResult {
  return {
    runId: ctx.runId,
    scenario: "unknown",
    passed: false,
    error,
    timing: {
      total: ctx.timing.duration(),
    },
    quality: {
      outputCorrect: false,
      score: 0,
      checks,
    },
    model: ctx.model,
    startedAt: new Date(Date.now() - ctx.timing.duration()),
    endedAt: new Date(),
  };
}

import { armRecoveryScenario } from "./scenarios/arm-recovery";
import { sessionIsolationScenario } from "./scenarios/session-isolation";

/**
 * All core scenarios
 */
export const coreScenarios: TestScenario[] = [
  infrastructureStartup,
  selfHealingApiRestart,
  zombieArmDetection,
  simpleTaskCompletion,
  armRecoveryScenario,
  sessionIsolationScenario,
];
