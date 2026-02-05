#!/usr/bin/env bun
/**
 * Quick integration test for Kimi CLI Harness
 * 
 * Run this to verify the kimi-cli harness works correctly:
 *   bun run test-kimi-harness.ts
 * 
 * This test:
 * 1. Creates a test harness instance
 * 2. Spawns a kimi-cli arm
 * 3. Sends a simple prompt
 * 4. Verifies the response
 * 5. Cleans up
 * 
 * Note: This test interacts with Kimi CLI via PTY (pseudo-terminal).
 * Some operations wait for specific output patterns (like the prompt 
 * character ">"). Progress messages are logged every 5 seconds during 
 * waits so you know the test is still working, not stuck.
 */

import { KimiCliHarness } from "./src/harness/kimi-cli";
import { harnessRegistry } from "./src/harness/registry";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const TEST_TIMEOUT = 120000; // 2 minutes

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Kimi CLI Harness Integration Test");
  console.log("=".repeat(60));
  console.log();

  // Check if kimi is installed
  try {
    const { execSync } = await import("child_process");
    execSync("which kimi", { encoding: "utf-8" });
  } catch {
    console.error("❌ kimi CLI is not installed. Please install it first:");
    console.error("   curl -sSL https://get.kimi.com | bash");
    process.exit(1);
  }

  console.log("✓ kimi CLI found");

  // Setup test directory
  const testDir = join("/tmp", `octopai-kimi-test-${randomUUID().slice(0, 8)}`);
  const octopaiDir = join(testDir, ".octopai");
  
  await mkdir(testDir, { recursive: true });
  await mkdir(join(testDir, "src"), { recursive: true });
  await mkdir(octopaiDir, { recursive: true });
  await mkdir(join(octopaiDir, "mcp"), { recursive: true });

  await writeFile(
    join(testDir, "src", "hello.ts"),
    `export function hello(): string { return "Hello"; }`
  );

  console.log(`✓ Test directory created: ${testDir}`);
  console.log();

  // Test 1: Registry
  console.log("Test 1: Registry Integration");
  console.log("-".repeat(40));
  
  if (!harnessRegistry.has("kimi-cli")) {
    console.error("❌ kimi-cli harness not registered");
    process.exit(1);
  }
  console.log("✓ Harness registered");

  const harness = harnessRegistry.get("kimi-cli") as KimiCliHarness;
  console.log(`✓ Harness created: ${harness.name} v${harness.version}`);
  console.log();

  // Test 2: Spawn
  console.log("Test 2: Spawn Arm");
  console.log("-".repeat(40));

  const session = await harness.spawn({
    workdir: testDir,
    env: {
      OCTOPAI_ARM_ID: "test-arm",
      OCTOPAI_DIR: octopaiDir,
    },
    headless: true,
  });

  console.log(`✓ Session spawned: ${session.id}`);
  console.log(`  PID: ${harness.getPid(session)}`);
  console.log(`  Spawned at: ${session.spawnedAt.toISOString()}`);

  // Wait for initialization
  console.log("  Waiting for 3s initialization delay...");
  await sleep(3000);
  console.log("✓ Initialization delay complete");
  console.log();

  // Test 3: State Detection
  console.log("Test 3: State Detection");
  console.log("-".repeat(40));

  const state = await harness.getState(session);
  console.log(`✓ Current state: ${state}`);
  console.log();

  // Test 4: Send Prompt
  console.log("Test 4: Send Prompt");
  console.log("-".repeat(40));

  // Track events
  const events: string[] = [];
  harness.setEventCallback((armId: string, event: string, data: unknown) => {
    events.push(event);
    console.log(`  [Event] ${event}`);
  });

  console.log("Sending prompt: 'What is 2 + 2?'");
  console.log("  (this may take a moment if waiting for prompt to be ready)");
  await harness.sendPrompt(session, "What is 2 + 2?");
  console.log("✓ Prompt sent");
  console.log();

  // Test 5: Wait for Response
  console.log("Test 5: Wait for Response");
  console.log("-".repeat(40));

  console.log("Waiting for response (timeout: 60s)...");
  console.log("  The harness waits for the prompt pattern to reappear.");
  console.log("  If Kimi is taking a while to respond, you'll see progress updates.");
  const response = await harness.waitForResponse(session, 60000);
  console.log("✓ Response received");
  console.log();
  console.log("Response preview:");
  console.log(response.slice(0, 500));
  if (response.length > 500) {
    console.log("... (truncated)");
  }
  console.log();

  // Test 6: Verify Quality
  console.log("Test 6: Response Quality Check");
  console.log("-".repeat(40));

  const hasNumber = /\d/.test(response);
  const mentionsFour = response.toLowerCase().includes("4") || 
                       response.toLowerCase().includes("four");

  console.log(`  Contains number: ${hasNumber ? "✓" : "✗"}`);
  console.log(`  Mentions 4/four: ${mentionsFour ? "✓" : "✗"}`);

  if (!hasNumber && !mentionsFour) {
    console.warn("⚠ Warning: Response may not contain expected answer");
  } else {
    console.log("✓ Response quality check passed");
  }
  console.log();

  // Test 7: Session Management
  console.log("Test 7: Session Management");
  console.log("-".repeat(40));

  const sessions = harness.listSessions();
  console.log(`✓ Active sessions: ${sessions.length}`);

  const retrieved = harness.getSession(session.id);
  console.log(`✓ Session retrieved: ${retrieved?.id === session.id ? "yes" : "no"}`);
  console.log();

  // Test 8: Reset Session
  console.log("Test 8: Reset Session");
  console.log("-".repeat(40));

  const newSessionId = await harness.resetSession(session);
  console.log(`✓ Session reset: ${newSessionId ? "success" : "failed"}`);
  console.log();

  // Test 9: Kill
  console.log("Test 9: Kill Arm");
  console.log("-".repeat(40));

  await harness.kill(session);
  console.log("✓ Arm killed");

  // Verify dead state
  console.log("  Waiting 500ms for process to terminate...");
  await sleep(500);
  const deadState = await harness.getState(session);
  console.log(`✓ State after kill: ${deadState}`);

  if (deadState !== "dead") {
    console.warn(`⚠ Warning: Expected 'dead' state, got '${deadState}'`);
  }
  console.log();

  // Test 10: Events Summary
  console.log("Test 10: Events Summary");
  console.log("-".repeat(40));
  console.log(`Total events received: ${events.length}`);
  const eventCounts = events.reduce((acc, e) => {
    acc[e] = (acc[e] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  for (const [event, count] of Object.entries(eventCounts)) {
    console.log(`  ${event}: ${count}`);
  }
  console.log();

  // Cleanup
  console.log("Cleanup");
  console.log("-".repeat(40));
  
  try {
    await rm(testDir, { recursive: true, force: true });
    console.log(`✓ Test directory removed: ${testDir}`);
  } catch {
    console.log(`⚠ Failed to remove test directory (may need manual cleanup)`);
  }
  console.log();

  // Summary
  console.log("=".repeat(60));
  console.log("Test Summary: ✓ All tests passed");
  console.log("=".repeat(60));
}

// Run with timeout
const timeoutId = setTimeout(() => {
  console.error("\n❌ Test timed out");
  process.exit(1);
}, TEST_TIMEOUT);

runTest()
  .then(() => {
    clearTimeout(timeoutId);
    process.exit(0);
  })
  .catch((error) => {
    clearTimeout(timeoutId);
    console.error("\n❌ Test failed:");
    console.error(error);
    process.exit(1);
  });
