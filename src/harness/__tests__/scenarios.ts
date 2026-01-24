/**
 * Harness Test Scenarios
 * 
 * Shared test scenarios that can be run against any harness implementation.
 * These scenarios validate that harnesses correctly:
 * 1. Report state to the brain
 * 2. Emit expected events
 * 3. Accept commands from the brain
 * 4. Handle lifecycle events properly
 */

import type { HarnessTestScenario } from "../contracts";

/**
 * Default spawn parameters for all test scenarios.
 * Uses the opencode provider with gpt-5-nano for fast, reliable testing.
 */
const DEFAULT_SPAWN_PARAMS = {
  headless: true,
  provider: "opencode",
  model: "gpt-5-nano",
};

/**
 * Basic lifecycle test: spawn -> idle -> prompt -> processing -> idle -> kill
 */
export const basicLifecycleScenario: HarnessTestScenario = {
  name: "Basic Lifecycle",
  description: "Tests spawn, prompt processing, and graceful shutdown",
  harnesses: ["opencode-tui", "opencode-api"],
  steps: [
    {
      action: "spawn",
      params: { ...DEFAULT_SPAWN_PARAMS },
      expectedState: {
        state: "idle",
        hasSession: true,
        healthy: true,
      },
    },
    {
      action: "wait",
      params: { duration: 2000 },
    },
    {
      action: "check_state",
      expectedState: {
        state: "idle",
        hasSession: true,
        healthy: true,
      },
    },
    {
      // Send a long prompt that takes time to process
      action: "prompt",
      params: { prompt: "Write a detailed paragraph about each of the following topics: 1) The history of computing, 2) How databases work, 3) The future of AI. Be thorough and include specific examples." },
    },
    {
      // Wait for processing state - the test framework will poll until it sees processing
      action: "wait_for_processing",
      params: { timeout: 10000 },
      expectedState: {
        state: "processing",
      },
    },
    {
      // Now wait for it to return to idle
      action: "wait_for_idle",
      params: { timeout: 120000 },
      expectedState: {
        state: "idle",
        healthy: true,
      },
    },
    {
      action: "kill",
    },
  ],
};

/**
 * State reporting test: verify brain can read correct harness state
 */
export const stateReportingScenario: HarnessTestScenario = {
  name: "State Reporting",
  description: "Verifies that the brain can accurately read harness state",
  harnesses: ["opencode-tui", "opencode-api"],
  steps: [
    {
      action: "spawn",
      params: { ...DEFAULT_SPAWN_PARAMS },
    },
    {
      action: "wait",
      params: { duration: 3000 },
    },
    {
      action: "check_state",
      expectedState: {
        state: "idle",
        hasSession: true,
        healthy: true,
      },
    },
    {
      action: "kill",
    },
    {
      action: "wait",
      params: { duration: 1000 },
    },
    // After kill, state should be dead or we shouldn't be able to get state
  ],
};

/**
 * Event emission test: verify expected events are emitted during lifecycle
 * 
 * Note: OpenCode emits specific event types via SSE:
 * - session.created: When a new session is created (we can't catch this - it's emitted BEFORE
 *   we connect to the SSE stream since we must first create a session)
 * - session.updated: When session metadata changes (we CAN catch this)
 * - message.updated: When a message is created OR updated (not "message.created")
 * - session.status: When session status changes (idle/busy) - not "message.completed"
 * - session.idle: When session becomes idle after processing
 * 
 * Important: expectedEvents are checked AFTER the step action completes.
 * Since message events are received asynchronously, we need to wait before checking for them.
 */
export const eventEmissionScenario: HarnessTestScenario = {
  name: "Event Emission",
  description: "Verifies that harness emits expected events during operations",
  harnesses: ["opencode-tui", "opencode-api"],
  steps: [
    {
      action: "spawn",
      params: { ...DEFAULT_SPAWN_PARAMS },
      // Note: We can't reliably catch session.created because it's emitted BEFORE
      // we connect to the SSE event stream (session must exist before we connect)
    },
    {
      action: "wait",
      params: { duration: 3000 },
      expectedEvents: [
        // server.connected is emitted when SSE connection is established
        { type: "server.connected", optional: true },
      ],
    },
    {
      action: "prompt",
      params: { prompt: "What is 2+2?" },
      // Don't check events here - they'll arrive asynchronously during the next wait
    },
    {
      action: "wait",
      params: { duration: 10000 },
      expectedEvents: [
        // These events should have been received by now:
        // message.updated - emitted when our user message was sent
        { type: "message.updated", optional: false },
        // session.idle - emitted when processing completes (or session.status with idle)
        { type: "session.idle", optional: false },
      ],
    },
    {
      action: "kill",
    },
  ],
};

/**
 * Interrupt handling test: verify interrupt works during processing
 */
export const interruptHandlingScenario: HarnessTestScenario = {
  name: "Interrupt Handling",
  description: "Verifies that harness can be interrupted during processing",
  harnesses: ["opencode-tui", "opencode-api"],
  steps: [
    {
      action: "spawn",
      params: { ...DEFAULT_SPAWN_PARAMS },
    },
    {
      action: "wait",
      params: { duration: 2000 },
    },
    {
      action: "prompt",
      // Long-running prompt to give us time to interrupt
      params: { prompt: "Write a detailed 10-paragraph essay about the history of computing." },
    },
    {
      action: "wait",
      params: { duration: 3000 },
    },
    {
      action: "interrupt",
    },
    {
      action: "wait",
      params: { duration: 2000 },
    },
    {
      action: "check_state",
      expectedState: {
        state: "idle",
        healthy: true,
      },
    },
    {
      action: "kill",
    },
  ],
};

/**
 * Health check test: verify health status is correctly reported
 */
export const healthCheckScenario: HarnessTestScenario = {
  name: "Health Check",
  description: "Verifies that harness health is correctly reported",
  harnesses: ["opencode-tui", "opencode-api"],
  steps: [
    {
      action: "spawn",
      params: { ...DEFAULT_SPAWN_PARAMS },
    },
    {
      action: "wait",
      params: { duration: 3000 },
    },
    {
      action: "check_state",
      expectedState: {
        state: "idle",
        healthy: true,
      },
    },
    {
      action: "kill",
    },
  ],
};

/**
 * Session persistence test: verify session is maintained
 */
export const sessionPersistenceScenario: HarnessTestScenario = {
  name: "Session Persistence",
  description: "Verifies that session is maintained across operations",
  harnesses: ["opencode-tui", "opencode-api"],
  steps: [
    {
      action: "spawn",
      params: { ...DEFAULT_SPAWN_PARAMS },
    },
    {
      action: "wait",
      params: { duration: 2000 },
    },
    {
      action: "check_state",
      expectedState: {
        state: "idle",
        hasSession: true,
      },
    },
    {
      action: "prompt",
      params: { prompt: "Remember the word 'elephant'." },
    },
    {
      action: "wait",
      params: { duration: 30000 },
    },
    {
      action: "check_state",
      expectedState: {
        hasSession: true,
        state: "idle",
      },
    },
    {
      action: "prompt",
      params: { prompt: "What word did I ask you to remember?" },
    },
    {
      action: "wait",
      params: { duration: 30000 },
    },
    {
      action: "check_state",
      expectedState: {
        hasSession: true,
        state: "idle",
      },
    },
    {
      action: "kill",
    },
  ],
};

/**
 * Quick spawn test: minimal test just to verify spawn/kill works
 */
export const quickSpawnScenario: HarnessTestScenario = {
  name: "Quick Spawn",
  description: "Quick test to verify spawn and kill work correctly",
  harnesses: ["opencode-tui", "opencode-api"],
  steps: [
    {
      action: "spawn",
      params: { ...DEFAULT_SPAWN_PARAMS },
    },
    {
      action: "wait",
      params: { duration: 5000 },
    },
    {
      action: "check_state",
      expectedState: {
        state: "idle",
        hasSession: true,
        healthy: true,
      },
    },
    {
      action: "kill",
    },
  ],
};

/**
 * Permission handling test: verify that permission dialogs work correctly
 * 
 * This test asks the agent to write a file outside the project directory (/tmp),
 * which should trigger a permission request. We then approve it and verify
 * the permission events are emitted.
 * 
 * Flow:
 * 1. Spawn harness
 * 2. Send prompt to create file in /tmp (triggers permission request)
 * 3. Wait for permission.asked event (SSE event)
 * 4. Respond to permission (approve "always" to handle follow-up requests)
 * 5. Wait for idle and verify permission.replied event
 * 
 * Note: We use "always" instead of "once" because the agent may make multiple
 * tool calls to the same directory (e.g., read then write).
 */
export const permissionHandlingScenario: HarnessTestScenario = {
  name: "Permission Handling",
  description: "Verifies that permission requests are correctly handled and events are emitted",
  harnesses: ["opencode-api", "opencode-tui"],
  steps: [
    {
      action: "spawn",
      params: { ...DEFAULT_SPAWN_PARAMS },
    },
    {
      action: "wait",
      params: { duration: 3000 },
    },
    {
      action: "check_state",
      expectedState: {
        state: "idle",
        hasSession: true,
        healthy: true,
      },
    },
    {
      // Ask to create a file in /tmp - this should trigger a permission request
      // because /tmp is outside the project directory
      action: "prompt",
      params: { 
        prompt: "Write a file at /tmp/octopai-test-permission.txt containing exactly 'Hello from Octopai permission test'. Do this in a single write tool call."
      },
    },
    {
      // Wait for the permission.asked event (comes via SSE, not control API)
      action: "wait_for_event",
      expectedEvents: [
        { type: "permission.asked", timeout: 30000 },
      ],
    },
    {
      // Approve the permission request with "always" to avoid blocking on follow-up requests
      action: "respond_to_permission",
      params: { 
        response: "always",
      },
    },
    {
      // Wait for completion
      action: "wait_for_idle",
      params: { timeout: 60000 },
    },
    {
      // Check that we received permission.replied event
      action: "wait",
      params: { duration: 2000 },
      expectedEvents: [
        { type: "permission.asked" },
        { type: "permission.replied", optional: true },
      ],
    },
    {
      action: "kill",
    },
  ],
};

/**
 * All standard test scenarios
 */
export const standardScenarios: HarnessTestScenario[] = [
  quickSpawnScenario,
  basicLifecycleScenario,
  stateReportingScenario,
  eventEmissionScenario,
  interruptHandlingScenario,
  healthCheckScenario,
  sessionPersistenceScenario,
  permissionHandlingScenario,
];

/**
 * Quick test scenarios (for fast validation)
 */
export const quickScenarios: HarnessTestScenario[] = [
  quickSpawnScenario,
  healthCheckScenario,
];

/**
 * Get scenarios by names
 */
export function getScenariosByNames(names: string[]): HarnessTestScenario[] {
  const nameSet = new Set(names.map(n => n.toLowerCase()));
  return standardScenarios.filter(s => nameSet.has(s.name.toLowerCase()));
}

/**
 * Get all scenario names
 */
export function getScenarioNames(): string[] {
  return standardScenarios.map(s => s.name);
}
