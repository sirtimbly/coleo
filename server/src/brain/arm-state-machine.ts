/**
 * Arm State Machine
 *
 * A formal state machine for managing arm lifecycle with persistence.
 * Survives process restarts and handles network disconnects gracefully.
 */

import type { ArmStateStore } from "./db-client";

// ============================================================================
// State Definitions
// ============================================================================

export type ArmState =
  | "spawning"        // Process being spawned, PID may not exist yet
  | "starting"        // Process exists, waiting for harness connection
  | "idle"            // Connected and ready for work
  | "task_assigned"   // Brain assigned task, waiting for arm acknowledgment
  | "working"         // Arm acknowledged task and is processing
  | "completing"      // Arm reported task complete, awaiting verification
  | "disconnected"    // Lost connection but may reconnect
  | "stopped"         // Intentionally stopped
  | "error";          // Unrecoverable error

// ============================================================================
// Event Definitions
// ============================================================================

export type ArmEvent =
  | { type: "SPAWN"; pid?: number }
  | { type: "PROCESS_STARTED"; pid: number }
  | { type: "HARNESS_CONNECTED" }
  | { type: "TASK_ASSIGNED"; taskId: string; taskSubject: string }
  | { type: "TASK_ACKNOWLEDGED"; taskId: string }
  | { type: "HEARTBEAT" }
  | { type: "TASK_COMPLETED"; taskId: string }
  | { type: "TASK_FAILED"; taskId: string; reason?: string }
  | { type: "CONNECTION_LOST" }
  | { type: "CONNECTION_RESTORED" }
  | { type: "STOP"; reason?: string }
  | { type: "ERROR"; message: string }
  | { type: "TIMEOUT"; context: string };

// ============================================================================
// State Context (data associated with current state)
// ============================================================================

export interface ArmStateContext {
  armId: string;
  state: ArmState;
  previousState?: ArmState;
  currentTaskId?: string;
  currentTaskSubject?: string;
  lastEventType?: string;
  lastEventAt: string;  // ISO timestamp
  stateEnteredAt: string;  // When we entered current state

  // Timeout tracking
  taskAssignedAt?: string;  // When task was assigned (for ack timeout)
  disconnectedAt?: string;  // When connection was lost (for reconnect timeout)

  // Error tracking
  lastError?: string;
  errorCount: number;

  // Connection tracking
  lastHeartbeat?: string;
  consecutiveMissedHeartbeats: number;
}

// ============================================================================
// Transition Result
// ============================================================================

export interface TransitionResult {
  success: boolean;
  previousState: ArmState;
  newState: ArmState;
  context: ArmStateContext;
  sideEffects?: SideEffect[];
  error?: string;
}

export type SideEffect =
  | { type: "LOG"; message: string; level: "info" | "warn" | "error" }
  | { type: "NOTIFY_ARM"; armId: string; message: string }
  | { type: "UPDATE_TASK_STATUS"; taskId: string; status: string }
  | { type: "RELEASE_TASK"; taskId: string }
  | { type: "MARK_ARM_STOPPED"; armId: string }
  | { type: "SCHEDULE_TIMEOUT"; key: string; delayMs: number; event: ArmEvent };

// ============================================================================
// State Transition Table
// ============================================================================

type TransitionHandler = (
  ctx: ArmStateContext,
  event: ArmEvent
) => { newState: ArmState; updates: Partial<ArmStateContext>; sideEffects?: SideEffect[] } | null;

// Define valid transitions: state -> event type -> handler
const TRANSITIONS: Record<ArmState, Partial<Record<ArmEvent["type"], TransitionHandler>>> = {
  spawning: {
    PROCESS_STARTED: (ctx, event) => {
      if (event.type !== "PROCESS_STARTED") return null;
      return {
        newState: "starting",
        updates: {},
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} process started (PID: ${event.pid})`, level: "info" },
          { type: "SCHEDULE_TIMEOUT", key: `${ctx.armId}:startup`, delayMs: 60000, event: { type: "TIMEOUT", context: "startup" } },
        ],
      };
    },
    ERROR: (ctx, event) => {
      if (event.type !== "ERROR") return null;
      return {
        newState: "error",
        updates: { lastError: event.message, errorCount: ctx.errorCount + 1 },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} spawn failed: ${event.message}`, level: "error" },
        ],
      };
    },
    TIMEOUT: (ctx) => ({
      newState: "error",
      updates: { lastError: "Spawn timeout" },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} spawn timeout`, level: "error" },
      ],
    }),
    STOP: (ctx) => ({
      newState: "stopped",
      updates: {},
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} stopped during spawn`, level: "info" },
      ],
    }),
  },

  starting: {
    HARNESS_CONNECTED: (ctx) => ({
      newState: "idle",
      updates: { lastHeartbeat: new Date().toISOString(), consecutiveMissedHeartbeats: 0 },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} harness connected, now idle`, level: "info" },
      ],
    }),
    HEARTBEAT: (ctx) => ({
      // Heartbeat during starting = harness is connected
      newState: "idle",
      updates: { lastHeartbeat: new Date().toISOString(), consecutiveMissedHeartbeats: 0 },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} received heartbeat during startup, now idle`, level: "info" },
      ],
    }),
    ERROR: (ctx, event) => {
      if (event.type !== "ERROR") return null;
      return {
        newState: "error",
        updates: { lastError: event.message, errorCount: ctx.errorCount + 1 },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} startup failed: ${event.message}`, level: "error" },
        ],
      };
    },
    TIMEOUT: (ctx) => ({
      newState: "error",
      updates: { lastError: "Startup timeout - harness never connected" },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} startup timeout`, level: "error" },
      ],
    }),
    STOP: (ctx) => ({
      newState: "stopped",
      updates: {},
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} stopped during startup`, level: "info" },
      ],
    }),
  },

  idle: {
    TASK_ASSIGNED: (ctx, event) => {
      if (event.type !== "TASK_ASSIGNED") return null;
      return {
        newState: "task_assigned",
        updates: {
          currentTaskId: event.taskId,
          currentTaskSubject: event.taskSubject,
          taskAssignedAt: new Date().toISOString(),
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} assigned task "${event.taskSubject}"`, level: "info" },
          // Allow 3 minutes for arm to acknowledge
          { type: "SCHEDULE_TIMEOUT", key: `${ctx.armId}:task_ack`, delayMs: 180000, event: { type: "TIMEOUT", context: "task_ack" } },
        ],
      };
    },
    HEARTBEAT: (ctx) => ({
      newState: "idle",  // Stay in idle
      updates: { lastHeartbeat: new Date().toISOString(), consecutiveMissedHeartbeats: 0 },
      sideEffects: [],
    }),
    CONNECTION_LOST: (ctx) => ({
      newState: "disconnected",
      updates: { disconnectedAt: new Date().toISOString() },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} connection lost while idle`, level: "warn" },
        { type: "SCHEDULE_TIMEOUT", key: `${ctx.armId}:reconnect`, delayMs: 300000, event: { type: "TIMEOUT", context: "reconnect" } },
      ],
    }),
    STOP: (ctx) => ({
      newState: "stopped",
      updates: {},
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} stopped while idle`, level: "info" },
        { type: "MARK_ARM_STOPPED", armId: ctx.armId },
      ],
    }),
    ERROR: (ctx, event) => {
      if (event.type !== "ERROR") return null;
      return {
        newState: "error",
        updates: { lastError: event.message, errorCount: ctx.errorCount + 1 },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} error while idle: ${event.message}`, level: "error" },
        ],
      };
    },
  },

  task_assigned: {
    TASK_ACKNOWLEDGED: (ctx, event) => {
      if (event.type !== "TASK_ACKNOWLEDGED") return null;
      if (event.taskId !== ctx.currentTaskId) {
        // Wrong task acknowledged - this shouldn't happen
        return {
          newState: "task_assigned",  // Stay in current state
          updates: {},
          sideEffects: [
            { type: "LOG", message: `Arm ${ctx.armId} acknowledged wrong task ${event.taskId} (expected ${ctx.currentTaskId})`, level: "warn" },
          ],
        };
      }
      return {
        newState: "working",
        updates: {},
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} acknowledged task "${ctx.currentTaskSubject}"`, level: "info" },
          { type: "UPDATE_TASK_STATUS", taskId: event.taskId, status: "in_progress" },
        ],
      };
    },
    HEARTBEAT: (ctx, event) => {
      if (event.type !== "HEARTBEAT") return null;
      // Heartbeat while task assigned - arm is awake, might be processing prompt
      // Keep waiting for explicit acknowledgment
      return {
        newState: "task_assigned",
        updates: { lastHeartbeat: new Date().toISOString(), consecutiveMissedHeartbeats: 0 },
        sideEffects: [],
      };
    },
    TIMEOUT: (ctx) => ({
      // Arm didn't acknowledge in time - release task and mark arm as problematic
      newState: "idle",
      updates: {
        currentTaskId: undefined,
        currentTaskSubject: undefined,
        taskAssignedAt: undefined,
        errorCount: ctx.errorCount + 1,
      },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} failed to acknowledge task "${ctx.currentTaskSubject}" - releasing`, level: "warn" },
        { type: "RELEASE_TASK", taskId: ctx.currentTaskId! },
      ],
    }),
    CONNECTION_LOST: (ctx) => ({
      newState: "disconnected",
      updates: { disconnectedAt: new Date().toISOString() },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} connection lost with task assigned`, level: "warn" },
        { type: "SCHEDULE_TIMEOUT", key: `${ctx.armId}:reconnect`, delayMs: 300000, event: { type: "TIMEOUT", context: "reconnect" } },
      ],
    }),
    STOP: (ctx) => ({
      newState: "stopped",
      updates: {},
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} stopped with unacknowledged task`, level: "warn" },
        { type: "RELEASE_TASK", taskId: ctx.currentTaskId! },
        { type: "MARK_ARM_STOPPED", armId: ctx.armId },
      ],
    }),
    // Allow task to be completed even without explicit ack (harness might not support ack)
    TASK_COMPLETED: (ctx, event) => {
      if (event.type !== "TASK_COMPLETED") return null;
      return {
        newState: "idle",
        updates: {
          currentTaskId: undefined,
          currentTaskSubject: undefined,
          taskAssignedAt: undefined,
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} completed task "${ctx.currentTaskSubject}" (skipped ack)`, level: "info" },
          { type: "UPDATE_TASK_STATUS", taskId: event.taskId, status: "completed" },
        ],
      };
    },
    TASK_FAILED: (ctx, event) => {
      if (event.type !== "TASK_FAILED") return null;
      return {
        newState: "idle",
        updates: {
          currentTaskId: undefined,
          currentTaskSubject: undefined,
          taskAssignedAt: undefined,
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} failed task "${ctx.currentTaskSubject}": ${event.reason}`, level: "warn" },
          { type: "UPDATE_TASK_STATUS", taskId: event.taskId, status: "failed" },
        ],
      };
    },
  },

  working: {
    HEARTBEAT: (ctx) => ({
      newState: "working",
      updates: { lastHeartbeat: new Date().toISOString(), consecutiveMissedHeartbeats: 0 },
      sideEffects: [],
    }),
    TASK_COMPLETED: (ctx, event) => {
      if (event.type !== "TASK_COMPLETED") return null;
      return {
        newState: "idle",
        updates: {
          currentTaskId: undefined,
          currentTaskSubject: undefined,
          taskAssignedAt: undefined,
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} completed task "${ctx.currentTaskSubject}"`, level: "info" },
          { type: "UPDATE_TASK_STATUS", taskId: event.taskId, status: "completed" },
        ],
      };
    },
    TASK_FAILED: (ctx, event) => {
      if (event.type !== "TASK_FAILED") return null;
      return {
        newState: "idle",
        updates: {
          currentTaskId: undefined,
          currentTaskSubject: undefined,
          taskAssignedAt: undefined,
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} failed task "${ctx.currentTaskSubject}": ${event.reason}`, level: "warn" },
          { type: "UPDATE_TASK_STATUS", taskId: event.taskId, status: "failed" },
        ],
      };
    },
    CONNECTION_LOST: (ctx) => ({
      newState: "disconnected",
      updates: { disconnectedAt: new Date().toISOString() },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} connection lost while working on "${ctx.currentTaskSubject}"`, level: "warn" },
        // Longer timeout for working arms - they might just be busy
        { type: "SCHEDULE_TIMEOUT", key: `${ctx.armId}:reconnect`, delayMs: 600000, event: { type: "TIMEOUT", context: "reconnect" } },
      ],
    }),
    STOP: (ctx) => ({
      newState: "stopped",
      updates: {},
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} stopped while working on "${ctx.currentTaskSubject}"`, level: "warn" },
        { type: "UPDATE_TASK_STATUS", taskId: ctx.currentTaskId!, status: "failed" },
        { type: "MARK_ARM_STOPPED", armId: ctx.armId },
      ],
    }),
    ERROR: (ctx, event) => {
      if (event.type !== "ERROR") return null;
      return {
        newState: "error",
        updates: { lastError: event.message, errorCount: ctx.errorCount + 1 },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} error while working: ${event.message}`, level: "error" },
          { type: "UPDATE_TASK_STATUS", taskId: ctx.currentTaskId!, status: "failed" },
        ],
      };
    },
  },

  completing: {
    // Future: verification workflow
    HEARTBEAT: (ctx) => ({
      newState: "completing",
      updates: { lastHeartbeat: new Date().toISOString() },
      sideEffects: [],
    }),
    TASK_COMPLETED: (ctx, event) => {
      if (event.type !== "TASK_COMPLETED") return null;
      return {
        newState: "idle",
        updates: {
          currentTaskId: undefined,
          currentTaskSubject: undefined,
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} task verified complete`, level: "info" },
          { type: "UPDATE_TASK_STATUS", taskId: event.taskId, status: "completed" },
        ],
      };
    },
    STOP: (ctx) => ({
      newState: "stopped",
      updates: {},
      sideEffects: [
        { type: "MARK_ARM_STOPPED", armId: ctx.armId },
      ],
    }),
  },

  disconnected: {
    CONNECTION_RESTORED: (ctx) => {
      // Restore to previous active state
      const restoreState = ctx.currentTaskId ? "working" : "idle";
      return {
        newState: restoreState,
        updates: {
          disconnectedAt: undefined,
          lastHeartbeat: new Date().toISOString(),
          consecutiveMissedHeartbeats: 0,
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} reconnected, restored to ${restoreState}`, level: "info" },
        ],
      };
    },
    HARNESS_CONNECTED: (ctx) => {
      // Same as CONNECTION_RESTORED
      const restoreState = ctx.currentTaskId ? "working" : "idle";
      return {
        newState: restoreState,
        updates: {
          disconnectedAt: undefined,
          lastHeartbeat: new Date().toISOString(),
          consecutiveMissedHeartbeats: 0,
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} harness reconnected`, level: "info" },
        ],
      };
    },
    HEARTBEAT: (ctx) => {
      // Heartbeat = reconnected
      const restoreState = ctx.currentTaskId ? "working" : "idle";
      return {
        newState: restoreState,
        updates: {
          disconnectedAt: undefined,
          lastHeartbeat: new Date().toISOString(),
          consecutiveMissedHeartbeats: 0,
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} heartbeat received, restored to ${restoreState}`, level: "info" },
        ],
      };
    },
    TIMEOUT: (ctx) => ({
      // Failed to reconnect - release any task and mark stopped
      newState: "stopped",
      updates: {},
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} reconnect timeout, marking stopped`, level: "warn" },
        ...(ctx.currentTaskId ? [{ type: "RELEASE_TASK" as const, taskId: ctx.currentTaskId }] : []),
        { type: "MARK_ARM_STOPPED", armId: ctx.armId },
      ],
    }),
    STOP: (ctx) => ({
      newState: "stopped",
      updates: {},
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} stopped while disconnected`, level: "info" },
        ...(ctx.currentTaskId ? [{ type: "RELEASE_TASK" as const, taskId: ctx.currentTaskId }] : []),
        { type: "MARK_ARM_STOPPED", armId: ctx.armId },
      ],
    }),
    // Allow task completion even while "disconnected" (message might arrive late)
    TASK_COMPLETED: (ctx, event) => {
      if (event.type !== "TASK_COMPLETED") return null;
      return {
        newState: "idle",
        updates: {
          currentTaskId: undefined,
          currentTaskSubject: undefined,
          disconnectedAt: undefined,
        },
        sideEffects: [
          { type: "LOG", message: `Arm ${ctx.armId} completed task while disconnected`, level: "info" },
          { type: "UPDATE_TASK_STATUS", taskId: event.taskId, status: "completed" },
        ],
      };
    },
  },

  stopped: {
    // From stopped, can only spawn again
    SPAWN: (ctx) => ({
      newState: "spawning",
      updates: {
        errorCount: 0,
        lastError: undefined,
        currentTaskId: undefined,
        currentTaskSubject: undefined,
      },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} respawning`, level: "info" },
      ],
    }),
  },

  error: {
    // From error, can stop or spawn again
    STOP: (ctx) => ({
      newState: "stopped",
      updates: {},
      sideEffects: [
        { type: "MARK_ARM_STOPPED", armId: ctx.armId },
      ],
    }),
    SPAWN: (ctx) => ({
      newState: "spawning",
      updates: { errorCount: 0, lastError: undefined },
      sideEffects: [
        { type: "LOG", message: `Arm ${ctx.armId} respawning after error`, level: "info" },
      ],
    }),
  },
};

// ============================================================================
// State Machine Class
// ============================================================================

export class ArmStateMachine {
  private db: ArmStateStore;
  private pendingTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onSideEffect?: (effect: SideEffect) => void | Promise<void>;

  constructor(db: ArmStateStore, onSideEffect?: (effect: SideEffect) => void | Promise<void>) {
    this.db = db;
    this.onSideEffect = onSideEffect;
  }

  /**
   * Get the current state context for an arm
   */
  getContext(armId: string): ArmStateContext | null {
    const row = this.db.getArmState(armId);

    if (!row) return null;

    return {
      armId: row.arm_id,
      state: row.state as ArmState,
      previousState: row.previous_state as ArmState | undefined,
      currentTaskId: row.current_task_id ?? undefined,
      currentTaskSubject: row.current_task_subject ?? undefined,
      lastEventType: row.last_event_type ?? undefined,
      lastEventAt: row.last_event_at,
      stateEnteredAt: row.state_entered_at,
      taskAssignedAt: row.task_assigned_at ?? undefined,
      disconnectedAt: row.disconnected_at ?? undefined,
      lastError: row.last_error ?? undefined,
      errorCount: row.error_count,
      lastHeartbeat: row.last_heartbeat ?? undefined,
      consecutiveMissedHeartbeats: row.consecutive_missed_heartbeats,
    };
  }

  /**
   * Initialize state for a new arm
   */
  initializeArm(armId: string, initialState: ArmState = "spawning"): ArmStateContext {
    const now = new Date().toISOString();
    const ctx: ArmStateContext = {
      armId,
      state: initialState,
      lastEventAt: now,
      stateEnteredAt: now,
      errorCount: 0,
      consecutiveMissedHeartbeats: 0,
    };

    this.db.upsertArmState(armId, {
      state: initialState,
      lastEventAt: now,
      stateEnteredAt: now,
      errorCount: 0,
      consecutiveMissedHeartbeats: 0,
      currentTaskId: null,
      currentTaskSubject: null,
      lastError: null,
    });

    return ctx;
  }

  /**
   * Send an event to the state machine and transition if valid
   */
  async transition(armId: string, event: ArmEvent): Promise<TransitionResult> {
    const ctx = this.getContext(armId);
    if (!ctx) {
      return {
        success: false,
        previousState: "stopped",
        newState: "stopped",
        context: {
          armId,
          state: "stopped",
          lastEventAt: new Date().toISOString(),
          stateEnteredAt: new Date().toISOString(),
          errorCount: 0,
          consecutiveMissedHeartbeats: 0,
        },
        error: `Arm ${armId} not found in state machine`,
      };
    }

    const transitions = TRANSITIONS[ctx.state];
    const handler = transitions?.[event.type];

    if (!handler) {
      // Invalid transition - log but don't fail
      return {
        success: false,
        previousState: ctx.state,
        newState: ctx.state,
        context: ctx,
        error: `Invalid transition: ${ctx.state} + ${event.type}`,
      };
    }

    const result = handler(ctx, event);
    if (!result) {
      return {
        success: false,
        previousState: ctx.state,
        newState: ctx.state,
        context: ctx,
        error: `Transition handler returned null`,
      };
    }

    const now = new Date().toISOString();
    const newContext: ArmStateContext = {
      ...ctx,
      ...result.updates,
      state: result.newState,
      previousState: ctx.state,
      lastEventType: event.type,
      lastEventAt: now,
      stateEnteredAt: result.newState !== ctx.state ? now : ctx.stateEnteredAt,
    };

    // Persist the new state
    this.persistContext(newContext);

    // Execute side effects
    if (result.sideEffects) {
      for (const effect of result.sideEffects) {
        await this.executeSideEffect(effect);
      }
    }

    return {
      success: true,
      previousState: ctx.state,
      newState: result.newState,
      context: newContext,
      sideEffects: result.sideEffects,
    };
  }

  /**
   * Persist context to database
   */
  private persistContext(ctx: ArmStateContext): void {
    this.db.upsertArmState(ctx.armId, {
      state: ctx.state,
      previousState: ctx.previousState ?? null,
      currentTaskId: ctx.currentTaskId ?? null,
      currentTaskSubject: ctx.currentTaskSubject ?? null,
      lastEventType: ctx.lastEventType ?? null,
      lastEventAt: ctx.lastEventAt,
      stateEnteredAt: ctx.stateEnteredAt,
      taskAssignedAt: ctx.taskAssignedAt ?? null,
      disconnectedAt: ctx.disconnectedAt ?? null,
      lastError: ctx.lastError ?? null,
      errorCount: ctx.errorCount,
      lastHeartbeat: ctx.lastHeartbeat ?? null,
      consecutiveMissedHeartbeats: ctx.consecutiveMissedHeartbeats,
    });
  }

  /**
   * Execute a side effect
   */
  private async executeSideEffect(effect: SideEffect): Promise<void> {
    if (effect.type === "SCHEDULE_TIMEOUT") {
      // Cancel any existing timeout with the same key
      const existing = this.pendingTimeouts.get(effect.key);
      if (existing) {
        clearTimeout(existing);
      }

      // Schedule new timeout
      const timeout = setTimeout(async () => {
        this.pendingTimeouts.delete(effect.key);
        const armId = effect.key.split(":")[0] ?? "";
        if (armId) {
          await this.transition(armId, effect.event);
        }
      }, effect.delayMs);

      this.pendingTimeouts.set(effect.key, timeout);
      return;
    }

    // Delegate to callback for other effects
    if (this.onSideEffect) {
      await this.onSideEffect(effect);
    }
  }

  /**
   * Cancel a scheduled timeout
   */
  cancelTimeout(key: string): void {
    const timeout = this.pendingTimeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(key);
    }
  }

  /**
   * Get all arms in a specific state
   */
  getArmsInState(state: ArmState): ArmStateContext[] {
    const rows = this.db.listArmStatesByState(state);

    return rows.map(row => ({
      armId: row.arm_id,
      state: row.state as ArmState,
      previousState: row.previous_state as ArmState | undefined,
      currentTaskId: row.current_task_id ?? undefined,
      currentTaskSubject: row.current_task_subject ?? undefined,
      lastEventType: row.last_event_type ?? undefined,
      lastEventAt: row.last_event_at,
      stateEnteredAt: row.state_entered_at,
      taskAssignedAt: row.task_assigned_at ?? undefined,
      disconnectedAt: row.disconnected_at ?? undefined,
      lastError: row.last_error ?? undefined,
      errorCount: row.error_count,
      lastHeartbeat: row.last_heartbeat ?? undefined,
      consecutiveMissedHeartbeats: row.consecutive_missed_heartbeats,
    }));
  }

  /**
   * Check if an arm can accept a new task
   */
  canAcceptTask(armId: string): boolean {
    const ctx = this.getContext(armId);
    return ctx?.state === "idle";
  }

  /**
   * Get human-readable status for UI
   */
  getDisplayStatus(armId: string): string {
    const ctx = this.getContext(armId);
    if (!ctx) return "unknown";

    switch (ctx.state) {
      case "spawning":
        return "starting";
      case "starting":
        return "starting";
      case "idle":
        return "idle";
      case "task_assigned":
        return "busy";  // For backward compat with existing UI
      case "working":
        return "busy";
      case "completing":
        return "busy";
      case "disconnected":
        return "disconnected";
      case "stopped":
        return "stopped";
      case "error":
        return "error";
      default:
        return "unknown";
    }
  }

  /**
   * Clean up on shutdown
   */
  shutdown(): void {
    for (const timeout of this.pendingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();
  }

  /**
   * Delete arm from state machine
   */
  deleteArm(armId: string): void {
    this.cancelTimeout(`${armId}:startup`);
    this.cancelTimeout(`${armId}:task_ack`);
    this.cancelTimeout(`${armId}:reconnect`);
    this.db.deleteArmState(armId);
  }
}

// ============================================================================
// Helper: Map legacy status to state machine state
// ============================================================================

export function legacyStatusToState(status: string): ArmState {
  switch (status) {
    case "starting":
    case "running":
      return "starting";
    case "idle":
      return "idle";
    case "busy":
      return "working";
    case "paused":
      return "idle";
    case "error":
      return "error";
    case "stopped":
      return "stopped";
    default:
      return "idle";
  }
}

export function stateToLegacyStatus(state: ArmState): string {
  switch (state) {
    case "spawning":
      return "starting";
    case "starting":
      return "starting";
    case "idle":
      return "idle";
    case "task_assigned":
      return "busy";
    case "working":
      return "busy";
    case "completing":
      return "busy";
    case "disconnected":
      return "error";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    default:
      return "idle";
  }
}
