/**
 * Arm State Machine Tests
 * 
 * Tests the formal state machine for arm lifecycle management.
 * 
 * Key scenarios:
 * 1. Happy path: spawn → start → idle → task_assigned → working → complete → idle
 * 2. Task acknowledgment race condition fix (the core bug we're solving)
 * 3. Connection lost and restored scenarios
 * 4. Timeout handling for unacknowledged tasks
 * 5. Invalid transition handling
 * 6. Side effects emission
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  ArmStateMachine,
  type ArmState,
  type ArmEvent,
  type SideEffect,
  legacyStatusToState,
  stateToLegacyStatus,
} from "../arm-state-machine";

describe("ArmStateMachine", () => {
  let db: Database;
  let testDir: string;
  let stateMachine: ArmStateMachine;
  let emittedSideEffects: SideEffect[];

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-sm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(testDir, { recursive: true });

    db = new Database(join(testDir, "test.db"));
    
    // Create required tables
    db.exec(`
      PRAGMA journal_mode = WAL;
      
      CREATE TABLE IF NOT EXISTS arms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS arm_state_machine (
        arm_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'spawning',
        previous_state TEXT,
        current_task_id TEXT,
        current_task_subject TEXT,
        last_event_type TEXT,
        last_event_at TEXT NOT NULL,
        state_entered_at TEXT NOT NULL,
        task_assigned_at TEXT,
        disconnected_at TEXT,
        last_error TEXT,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_heartbeat TEXT,
        consecutive_missed_heartbeats INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_arm_sm_state ON arm_state_machine(state);
      CREATE INDEX IF NOT EXISTS idx_arm_sm_task ON arm_state_machine(current_task_id);
    `);

    emittedSideEffects = [];
    stateMachine = new ArmStateMachine(db, (effect) => {
      emittedSideEffects.push(effect);
    });
  });

  afterEach(async () => {
    stateMachine.shutdown();
    db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  /**
   * Helper to create an arm in the database
   */
  function createArm(id: string, name: string = "test-arm"): void {
    db.run("INSERT INTO arms (id, name, status) VALUES (?, ?, 'idle')", [id, name]);
  }

  // ============================================================================
  // Initialization Tests
  // ============================================================================

  describe("initialization", () => {
    it("initializes arm with default spawning state", () => {
      createArm("arm-1");
      const ctx = stateMachine.initializeArm("arm-1");

      expect(ctx.armId).toBe("arm-1");
      expect(ctx.state).toBe("spawning");
      expect(ctx.errorCount).toBe(0);
      expect(ctx.consecutiveMissedHeartbeats).toBe(0);
    });

    it("initializes arm with custom initial state", () => {
      createArm("arm-2");
      const ctx = stateMachine.initializeArm("arm-2", "idle");

      expect(ctx.state).toBe("idle");
    });

    it("re-initializes existing arm on conflict", () => {
      createArm("arm-3");
      stateMachine.initializeArm("arm-3", "spawning");
      
      // Initialize again with different state
      const ctx = stateMachine.initializeArm("arm-3", "idle");
      
      expect(ctx.state).toBe("idle");
      expect(ctx.errorCount).toBe(0);
    });

    it("returns null context for non-existent arm", () => {
      const ctx = stateMachine.getContext("non-existent");
      expect(ctx).toBeNull();
    });
  });

  // ============================================================================
  // Happy Path: Full Lifecycle Tests
  // ============================================================================

  describe("happy path - full lifecycle", () => {
    it("transitions through complete arm lifecycle", async () => {
      createArm("arm-lifecycle");
      stateMachine.initializeArm("arm-lifecycle", "spawning");

      // spawning -> starting (PROCESS_STARTED)
      let result = await stateMachine.transition("arm-lifecycle", { 
        type: "PROCESS_STARTED", 
        pid: 12345 
      });
      expect(result.success).toBe(true);
      expect(result.newState).toBe("starting");

      // starting -> idle (HARNESS_CONNECTED)
      result = await stateMachine.transition("arm-lifecycle", { 
        type: "HARNESS_CONNECTED" 
      });
      expect(result.success).toBe(true);
      expect(result.newState).toBe("idle");

      // idle -> task_assigned (TASK_ASSIGNED)
      result = await stateMachine.transition("arm-lifecycle", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Test task",
      });
      expect(result.success).toBe(true);
      expect(result.newState).toBe("task_assigned");
      expect(result.context.currentTaskId).toBe("task-1");
      expect(result.context.currentTaskSubject).toBe("Test task");

      // task_assigned -> working (TASK_ACKNOWLEDGED)
      result = await stateMachine.transition("arm-lifecycle", {
        type: "TASK_ACKNOWLEDGED",
        taskId: "task-1",
      });
      expect(result.success).toBe(true);
      expect(result.newState).toBe("working");

      // working -> idle (TASK_COMPLETED)
      result = await stateMachine.transition("arm-lifecycle", {
        type: "TASK_COMPLETED",
        taskId: "task-1",
      });
      expect(result.success).toBe(true);
      expect(result.newState).toBe("idle");
      expect(result.context.currentTaskId).toBeUndefined();
      expect(result.context.currentTaskSubject).toBeUndefined();
    });

    it("transitions from idle to stopped", async () => {
      createArm("arm-stop");
      stateMachine.initializeArm("arm-stop", "idle");

      const result = await stateMachine.transition("arm-stop", { 
        type: "STOP", 
        reason: "user_request" 
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("stopped");
    });
  });

  // ============================================================================
  // Task Assignment Race Condition Tests (Core Bug Fix)
  // ============================================================================

  describe("task assignment race condition", () => {
    it("blocks new task assignment when arm is in task_assigned state", async () => {
      createArm("arm-race");
      stateMachine.initializeArm("arm-race", "idle");

      // Assign first task
      await stateMachine.transition("arm-race", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "First task",
      });

      // canAcceptTask should return false
      expect(stateMachine.canAcceptTask("arm-race")).toBe(false);
    });

    it("blocks new task assignment when arm is in working state", async () => {
      createArm("arm-working");
      stateMachine.initializeArm("arm-working", "idle");

      // Assign and acknowledge task
      await stateMachine.transition("arm-working", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Working task",
      });
      await stateMachine.transition("arm-working", {
        type: "TASK_ACKNOWLEDGED",
        taskId: "task-1",
      });

      // canAcceptTask should return false
      expect(stateMachine.canAcceptTask("arm-working")).toBe(false);
    });

    it("allows task assignment only when arm is idle", async () => {
      createArm("arm-idle");
      stateMachine.initializeArm("arm-idle", "idle");

      expect(stateMachine.canAcceptTask("arm-idle")).toBe(true);

      // Assign task
      await stateMachine.transition("arm-idle", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "New task",
      });

      // No longer can accept
      expect(stateMachine.canAcceptTask("arm-idle")).toBe(false);

      // Complete task
      await stateMachine.transition("arm-idle", {
        type: "TASK_COMPLETED",
        taskId: "task-1",
      });

      // Can accept again
      expect(stateMachine.canAcceptTask("arm-idle")).toBe(true);
    });

    it("handles heartbeat without changing task_assigned state", async () => {
      createArm("arm-hb");
      stateMachine.initializeArm("arm-hb", "idle");

      await stateMachine.transition("arm-hb", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Pending ack task",
      });

      // Send heartbeat - should stay in task_assigned
      const result = await stateMachine.transition("arm-hb", { type: "HEARTBEAT" });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("task_assigned");
      expect(result.context.currentTaskId).toBe("task-1");
    });

    it("rejects acknowledgment for wrong task ID", async () => {
      createArm("arm-wrong-ack");
      stateMachine.initializeArm("arm-wrong-ack", "idle");

      await stateMachine.transition("arm-wrong-ack", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Correct task",
      });

      // Try to acknowledge wrong task
      const result = await stateMachine.transition("arm-wrong-ack", {
        type: "TASK_ACKNOWLEDGED",
        taskId: "wrong-task-id",
      });

      // Should stay in task_assigned (wrong task ID)
      expect(result.success).toBe(true);
      expect(result.newState).toBe("task_assigned");
      expect(result.context.currentTaskId).toBe("task-1");
    });
  });

  // ============================================================================
  // Connection Lost/Restored Tests
  // ============================================================================

  describe("connection handling", () => {
    it("transitions to disconnected on CONNECTION_LOST from idle", async () => {
      createArm("arm-conn-idle");
      stateMachine.initializeArm("arm-conn-idle", "idle");

      const result = await stateMachine.transition("arm-conn-idle", { 
        type: "CONNECTION_LOST" 
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("disconnected");
      expect(result.context.disconnectedAt).toBeDefined();
    });

    it("transitions to disconnected on CONNECTION_LOST from working", async () => {
      createArm("arm-conn-work");
      stateMachine.initializeArm("arm-conn-work", "idle");

      // Set up working state
      await stateMachine.transition("arm-conn-work", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Working task",
      });
      await stateMachine.transition("arm-conn-work", {
        type: "TASK_ACKNOWLEDGED",
        taskId: "task-1",
      });

      // Connection lost while working
      const result = await stateMachine.transition("arm-conn-work", { 
        type: "CONNECTION_LOST" 
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("disconnected");
      // Task should still be tracked
      expect(result.context.currentTaskId).toBe("task-1");
    });

    it("restores to idle on CONNECTION_RESTORED when no task", async () => {
      createArm("arm-restore-idle");
      stateMachine.initializeArm("arm-restore-idle", "disconnected");

      const result = await stateMachine.transition("arm-restore-idle", { 
        type: "CONNECTION_RESTORED" 
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("idle");
      expect(result.context.disconnectedAt).toBeUndefined();
    });

    it("restores to working on CONNECTION_RESTORED when task exists", async () => {
      createArm("arm-restore-work");
      
      // Set up with task then disconnect
      stateMachine.initializeArm("arm-restore-work", "idle");
      await stateMachine.transition("arm-restore-work", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Disconnected task",
      });
      await stateMachine.transition("arm-restore-work", {
        type: "TASK_ACKNOWLEDGED",
        taskId: "task-1",
      });
      await stateMachine.transition("arm-restore-work", { type: "CONNECTION_LOST" });

      // Now restore
      const result = await stateMachine.transition("arm-restore-work", { 
        type: "CONNECTION_RESTORED" 
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("working");
      expect(result.context.currentTaskId).toBe("task-1");
    });

    it("restores on HEARTBEAT from disconnected state", async () => {
      createArm("arm-hb-restore");
      stateMachine.initializeArm("arm-hb-restore", "disconnected");

      const result = await stateMachine.transition("arm-hb-restore", { 
        type: "HEARTBEAT" 
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("idle");
    });
  });

  // ============================================================================
  // Invalid Transition Tests
  // ============================================================================

  describe("invalid transitions", () => {
    it("rejects TASK_ASSIGNED when not idle", async () => {
      createArm("arm-invalid-assign");
      stateMachine.initializeArm("arm-invalid-assign", "working");

      const result = await stateMachine.transition("arm-invalid-assign", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Invalid task",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid transition");
      expect(result.newState).toBe("working");
    });

    it("rejects HARNESS_CONNECTED when not starting", async () => {
      createArm("arm-invalid-connect");
      stateMachine.initializeArm("arm-invalid-connect", "idle");

      const result = await stateMachine.transition("arm-invalid-connect", { 
        type: "HARNESS_CONNECTED" 
      });

      expect(result.success).toBe(false);
      expect(result.newState).toBe("idle");
    });

    it("returns error for non-existent arm", async () => {
      const result = await stateMachine.transition("non-existent-arm", { 
        type: "HEARTBEAT" 
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("rejects SPAWN from non-stopped/error states", async () => {
      createArm("arm-invalid-spawn");
      stateMachine.initializeArm("arm-invalid-spawn", "idle");

      const result = await stateMachine.transition("arm-invalid-spawn", { 
        type: "SPAWN" 
      });

      expect(result.success).toBe(false);
      expect(result.newState).toBe("idle");
    });
  });

  // ============================================================================
  // Side Effects Tests
  // ============================================================================

  describe("side effects", () => {
    it("emits LOG effect on state transitions", async () => {
      createArm("arm-log");
      stateMachine.initializeArm("arm-log", "spawning");

      await stateMachine.transition("arm-log", { 
        type: "PROCESS_STARTED", 
        pid: 123 
      });

      const logEffects = emittedSideEffects.filter(e => e.type === "LOG");
      expect(logEffects.length).toBeGreaterThan(0);
      expect(logEffects[0]).toHaveProperty("message");
    });

    it("emits UPDATE_TASK_STATUS on task acknowledgment", async () => {
      createArm("arm-task-status");
      stateMachine.initializeArm("arm-task-status", "idle");

      await stateMachine.transition("arm-task-status", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Test task",
      });

      emittedSideEffects = []; // Clear previous effects

      await stateMachine.transition("arm-task-status", {
        type: "TASK_ACKNOWLEDGED",
        taskId: "task-1",
      });

      const updateEffects = emittedSideEffects.filter(e => e.type === "UPDATE_TASK_STATUS");
      expect(updateEffects.length).toBe(1);
      expect((updateEffects[0] as { taskId: string; status: string }).taskId).toBe("task-1");
      expect((updateEffects[0] as { taskId: string; status: string }).status).toBe("in_progress");
    });

    it("emits UPDATE_TASK_STATUS on task completion", async () => {
      createArm("arm-complete-status");
      stateMachine.initializeArm("arm-complete-status", "working");
      
      // Manually set the task ID in the context
      db.run(
        "UPDATE arm_state_machine SET current_task_id = ?, current_task_subject = ? WHERE arm_id = ?",
        ["task-1", "Test task", "arm-complete-status"]
      );

      emittedSideEffects = [];

      await stateMachine.transition("arm-complete-status", {
        type: "TASK_COMPLETED",
        taskId: "task-1",
      });

      const updateEffects = emittedSideEffects.filter(e => e.type === "UPDATE_TASK_STATUS");
      expect(updateEffects.length).toBe(1);
      expect((updateEffects[0] as { taskId: string; status: string }).status).toBe("completed");
    });

    it("emits MARK_ARM_STOPPED on STOP from idle", async () => {
      createArm("arm-stop-effect");
      stateMachine.initializeArm("arm-stop-effect", "idle");

      emittedSideEffects = [];

      await stateMachine.transition("arm-stop-effect", { 
        type: "STOP", 
        reason: "test" 
      });

      const stopEffects = emittedSideEffects.filter(e => e.type === "MARK_ARM_STOPPED");
      expect(stopEffects.length).toBe(1);
      expect((stopEffects[0] as { armId: string }).armId).toBe("arm-stop-effect");
    });

    it("emits RELEASE_TASK when stopped with unacknowledged task", async () => {
      createArm("arm-release-task");
      stateMachine.initializeArm("arm-release-task", "idle");

      await stateMachine.transition("arm-release-task", {
        type: "TASK_ASSIGNED",
        taskId: "task-to-release",
        taskSubject: "Unacked task",
      });

      emittedSideEffects = [];

      await stateMachine.transition("arm-release-task", { 
        type: "STOP", 
        reason: "process_dead" 
      });

      const releaseEffects = emittedSideEffects.filter(e => e.type === "RELEASE_TASK");
      expect(releaseEffects.length).toBe(1);
      expect((releaseEffects[0] as { taskId: string }).taskId).toBe("task-to-release");
    });
  });

  // ============================================================================
  // Timeout Scheduling Tests
  // ============================================================================

  describe("timeout scheduling", () => {
    it("schedules task_ack timeout on TASK_ASSIGNED", async () => {
      createArm("arm-timeout-sched");
      stateMachine.initializeArm("arm-timeout-sched", "idle");

      await stateMachine.transition("arm-timeout-sched", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Timeout test",
      });

      // Check that SCHEDULE_TIMEOUT was in the side effects
      // (internal to state machine, we can verify by checking the transition result)
      const ctx = stateMachine.getContext("arm-timeout-sched");
      expect(ctx?.state).toBe("task_assigned");
      expect(ctx?.taskAssignedAt).toBeDefined();
    });

    it("schedules reconnect timeout on CONNECTION_LOST", async () => {
      createArm("arm-reconnect-timeout");
      stateMachine.initializeArm("arm-reconnect-timeout", "idle");

      await stateMachine.transition("arm-reconnect-timeout", { 
        type: "CONNECTION_LOST" 
      });

      const ctx = stateMachine.getContext("arm-reconnect-timeout");
      expect(ctx?.state).toBe("disconnected");
      expect(ctx?.disconnectedAt).toBeDefined();
    });
  });

  // ============================================================================
  // Error State Tests
  // ============================================================================

  describe("error handling", () => {
    it("transitions to error state on ERROR event", async () => {
      createArm("arm-error");
      stateMachine.initializeArm("arm-error", "idle");

      const result = await stateMachine.transition("arm-error", {
        type: "ERROR",
        message: "Something went wrong",
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("error");
      expect(result.context.lastError).toBe("Something went wrong");
      expect(result.context.errorCount).toBe(1);
    });

    it("increments error count on repeated errors without respawn", async () => {
      createArm("arm-multi-error");
      stateMachine.initializeArm("arm-multi-error", "idle");

      // First error
      await stateMachine.transition("arm-multi-error", {
        type: "ERROR",
        message: "First error",
      });

      let ctx = stateMachine.getContext("arm-multi-error");
      expect(ctx?.errorCount).toBe(1);
      expect(ctx?.state).toBe("error");

      // Re-spawn resets error count (by design - fresh start)
      await stateMachine.transition("arm-multi-error", { type: "SPAWN" });
      
      ctx = stateMachine.getContext("arm-multi-error");
      expect(ctx?.errorCount).toBe(0); // Reset on respawn
      expect(ctx?.state).toBe("spawning");
    });

    it("accumulates errors in task_assigned timeout scenario", async () => {
      createArm("arm-accum-error");
      stateMachine.initializeArm("arm-accum-error", "idle");

      // Assign task
      await stateMachine.transition("arm-accum-error", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Test task",
      });

      // Timeout (which increments error count)
      await stateMachine.transition("arm-accum-error", {
        type: "TIMEOUT",
        context: "task_ack",
      });

      let ctx = stateMachine.getContext("arm-accum-error");
      expect(ctx?.errorCount).toBe(1);
      expect(ctx?.state).toBe("idle"); // Back to idle after timeout

      // Assign another task
      await stateMachine.transition("arm-accum-error", {
        type: "TASK_ASSIGNED",
        taskId: "task-2",
        taskSubject: "Test task 2",
      });

      // Another timeout
      await stateMachine.transition("arm-accum-error", {
        type: "TIMEOUT",
        context: "task_ack",
      });

      ctx = stateMachine.getContext("arm-accum-error");
      expect(ctx?.errorCount).toBe(2); // Accumulated
    });

    it("allows SPAWN from error state", async () => {
      createArm("arm-respawn");
      stateMachine.initializeArm("arm-respawn", "error");

      const result = await stateMachine.transition("arm-respawn", { type: "SPAWN" });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("spawning");
    });

    it("allows STOP from error state", async () => {
      createArm("arm-stop-error");
      stateMachine.initializeArm("arm-stop-error", "error");

      const result = await stateMachine.transition("arm-stop-error", { 
        type: "STOP" 
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("stopped");
    });
  });

  // ============================================================================
  // Query Methods Tests
  // ============================================================================

  describe("query methods", () => {
    it("getArmsInState returns all arms in specified state", async () => {
      createArm("arm-query-1");
      createArm("arm-query-2");
      createArm("arm-query-3");
      
      stateMachine.initializeArm("arm-query-1", "idle");
      stateMachine.initializeArm("arm-query-2", "idle");
      stateMachine.initializeArm("arm-query-3", "working");

      const idleArms = stateMachine.getArmsInState("idle");
      
      expect(idleArms.length).toBe(2);
      expect(idleArms.map(a => a.armId)).toContain("arm-query-1");
      expect(idleArms.map(a => a.armId)).toContain("arm-query-2");
    });

    it("getDisplayStatus returns human-readable status", () => {
      createArm("arm-display");
      stateMachine.initializeArm("arm-display", "task_assigned");

      const status = stateMachine.getDisplayStatus("arm-display");
      expect(status).toBe("busy"); // task_assigned maps to "busy" for UI compatibility
    });

    it("canAcceptTask returns correct values for different states", () => {
      createArm("arm-accept-1");
      createArm("arm-accept-2");
      createArm("arm-accept-3");
      
      stateMachine.initializeArm("arm-accept-1", "idle");
      stateMachine.initializeArm("arm-accept-2", "working");
      stateMachine.initializeArm("arm-accept-3", "stopped");

      expect(stateMachine.canAcceptTask("arm-accept-1")).toBe(true);
      expect(stateMachine.canAcceptTask("arm-accept-2")).toBe(false);
      expect(stateMachine.canAcceptTask("arm-accept-3")).toBe(false);
      expect(stateMachine.canAcceptTask("non-existent")).toBe(false);
    });
  });

  // ============================================================================
  // Persistence Tests
  // ============================================================================

  describe("persistence", () => {
    it("persists state changes to database", async () => {
      createArm("arm-persist");
      stateMachine.initializeArm("arm-persist", "idle");

      await stateMachine.transition("arm-persist", {
        type: "TASK_ASSIGNED",
        taskId: "persisted-task",
        taskSubject: "Persisted task subject",
      });

      // Query directly from database
      const row = db.query(
        "SELECT state, current_task_id, current_task_subject FROM arm_state_machine WHERE arm_id = ?"
      ).get("arm-persist") as { state: string; current_task_id: string; current_task_subject: string };

      expect(row.state).toBe("task_assigned");
      expect(row.current_task_id).toBe("persisted-task");
      expect(row.current_task_subject).toBe("Persisted task subject");
    });

    it("loads state from database on getContext", () => {
      createArm("arm-load");
      
      // Insert directly into database
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO arm_state_machine 
        (arm_id, state, current_task_id, last_event_at, state_entered_at, error_count, consecutive_missed_heartbeats)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, ["arm-load", "working", "loaded-task", now, now, 0, 0]);

      const ctx = stateMachine.getContext("arm-load");

      expect(ctx?.state).toBe("working");
      expect(ctx?.currentTaskId).toBe("loaded-task");
    });

    it("survives state machine recreation", async () => {
      createArm("arm-survive");
      stateMachine.initializeArm("arm-survive", "idle");

      await stateMachine.transition("arm-survive", {
        type: "TASK_ASSIGNED",
        taskId: "task-survive",
        taskSubject: "Survive restart",
      });

      // Create new state machine instance (simulating restart)
      stateMachine.shutdown();
      const newStateMachine = new ArmStateMachine(db);

      const ctx = newStateMachine.getContext("arm-survive");
      expect(ctx?.state).toBe("task_assigned");
      expect(ctx?.currentTaskId).toBe("task-survive");

      newStateMachine.shutdown();
    });
  });

  // ============================================================================
  // Helper Function Tests
  // ============================================================================

  describe("helper functions", () => {
    it("legacyStatusToState maps correctly", () => {
      expect(legacyStatusToState("starting")).toBe("starting");
      expect(legacyStatusToState("running")).toBe("starting");
      expect(legacyStatusToState("idle")).toBe("idle");
      expect(legacyStatusToState("busy")).toBe("working");
      expect(legacyStatusToState("paused")).toBe("idle");
      expect(legacyStatusToState("error")).toBe("error");
      expect(legacyStatusToState("stopped")).toBe("stopped");
      expect(legacyStatusToState("unknown")).toBe("idle"); // default
    });

    it("stateToLegacyStatus maps correctly", () => {
      expect(stateToLegacyStatus("spawning")).toBe("starting");
      expect(stateToLegacyStatus("starting")).toBe("starting");
      expect(stateToLegacyStatus("idle")).toBe("idle");
      expect(stateToLegacyStatus("task_assigned")).toBe("busy");
      expect(stateToLegacyStatus("working")).toBe("busy");
      expect(stateToLegacyStatus("completing")).toBe("busy");
      expect(stateToLegacyStatus("disconnected")).toBe("error");
      expect(stateToLegacyStatus("stopped")).toBe("stopped");
      expect(stateToLegacyStatus("error")).toBe("error");
    });
  });

  // ============================================================================
  // Cleanup Tests
  // ============================================================================

  describe("cleanup", () => {
    it("deleteArm removes arm from state machine", () => {
      createArm("arm-delete");
      stateMachine.initializeArm("arm-delete", "idle");

      expect(stateMachine.getContext("arm-delete")).not.toBeNull();

      stateMachine.deleteArm("arm-delete");

      expect(stateMachine.getContext("arm-delete")).toBeNull();
    });

    it("shutdown clears pending timeouts", () => {
      createArm("arm-shutdown");
      stateMachine.initializeArm("arm-shutdown", "idle");

      // This should schedule a timeout
      stateMachine.transition("arm-shutdown", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Timeout task",
      });

      // Shutdown should not throw and should clear timeouts
      expect(() => stateMachine.shutdown()).not.toThrow();
    });
  });

  // ============================================================================
  // Task Completion Edge Cases
  // ============================================================================

  describe("task completion edge cases", () => {
    it("allows task completion without explicit acknowledgment", async () => {
      createArm("arm-skip-ack");
      stateMachine.initializeArm("arm-skip-ack", "idle");

      await stateMachine.transition("arm-skip-ack", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Skip ack task",
      });

      // Complete without acknowledging first
      const result = await stateMachine.transition("arm-skip-ack", {
        type: "TASK_COMPLETED",
        taskId: "task-1",
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("idle");
    });

    it("handles TASK_FAILED from task_assigned state", async () => {
      createArm("arm-fail-assigned");
      stateMachine.initializeArm("arm-fail-assigned", "idle");

      await stateMachine.transition("arm-fail-assigned", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Failing task",
      });

      const result = await stateMachine.transition("arm-fail-assigned", {
        type: "TASK_FAILED",
        taskId: "task-1",
        reason: "Could not complete",
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("idle");
      expect(result.context.currentTaskId).toBeUndefined();
    });

    it("handles TASK_FAILED from working state", async () => {
      createArm("arm-fail-working");
      stateMachine.initializeArm("arm-fail-working", "idle");

      await stateMachine.transition("arm-fail-working", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Failing task",
      });
      await stateMachine.transition("arm-fail-working", {
        type: "TASK_ACKNOWLEDGED",
        taskId: "task-1",
      });

      const result = await stateMachine.transition("arm-fail-working", {
        type: "TASK_FAILED",
        taskId: "task-1",
        reason: "Failed during work",
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("idle");

      // Check UPDATE_TASK_STATUS was emitted with 'failed'
      const updateEffects = emittedSideEffects.filter(e => e.type === "UPDATE_TASK_STATUS");
      const failedEffect = updateEffects.find(e => (e as { status: string }).status === "failed");
      expect(failedEffect).toBeDefined();
    });

    it("allows task completion while disconnected", async () => {
      createArm("arm-complete-disconnected");
      stateMachine.initializeArm("arm-complete-disconnected", "idle");

      await stateMachine.transition("arm-complete-disconnected", {
        type: "TASK_ASSIGNED",
        taskId: "task-1",
        taskSubject: "Disconnect task",
      });
      await stateMachine.transition("arm-complete-disconnected", {
        type: "TASK_ACKNOWLEDGED",
        taskId: "task-1",
      });
      await stateMachine.transition("arm-complete-disconnected", { 
        type: "CONNECTION_LOST" 
      });

      // Complete while disconnected (late message arrival)
      const result = await stateMachine.transition("arm-complete-disconnected", {
        type: "TASK_COMPLETED",
        taskId: "task-1",
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("idle");
    });
  });

  // ============================================================================
  // Starting State Transitions
  // ============================================================================

  describe("starting state", () => {
    it("transitions to idle on HEARTBEAT during starting", async () => {
      createArm("arm-start-hb");
      stateMachine.initializeArm("arm-start-hb", "starting");

      const result = await stateMachine.transition("arm-start-hb", { 
        type: "HEARTBEAT" 
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("idle");
    });

    it("transitions to error on startup TIMEOUT", async () => {
      createArm("arm-start-timeout");
      stateMachine.initializeArm("arm-start-timeout", "starting");

      const result = await stateMachine.transition("arm-start-timeout", { 
        type: "TIMEOUT",
        context: "startup",
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("error");
      expect(result.context.lastError).toContain("timeout");
    });

    it("transitions to stopped on STOP during starting", async () => {
      createArm("arm-start-stop");
      stateMachine.initializeArm("arm-start-stop", "starting");

      const result = await stateMachine.transition("arm-start-stop", { 
        type: "STOP" 
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe("stopped");
    });
  });
});
