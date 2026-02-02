/**
 * ArmHealthMonitor - Unified arm health monitoring system
 *
 * Replaces checkStuckArms and checkIdleArmStuckLoops with a single,
 * event-window-based monitoring system. Periodically:
 * 1. Pulls event windows for all arms
 * 2. Runs the activity analyzer
 * 3. Invokes the permission engine for pending permissions
 * 4. Emits intervention events for observability
 */

import { BrainEventWindow, type ArmEventWindow } from "./event-window";
import { ArmActivityAnalyzer, type ArmAnalysis, type ArmActivityState } from "./activity-analyzer";
import { PermissionDecisionEngine, type PermissionRequest } from "./permission-engine";
import { eventStore } from "../nats/jetstream";
import type { Database } from "../db";

/**
 * Intervention types the monitor can take
 */
export type InterventionType =
  | "prompt"      // Send a nudge to the arm
  | "interrupt"   // Interrupt current operation
  | "kill"        // Kill the arm
  | "escalate"    // Escalate to human
  | "none";       // No action needed

/**
 * Intervention record for auditing
 */
export interface Intervention {
  armId: string;
  type: InterventionType;
  reason: string;
  state: ArmActivityState;
  timestamp: Date;
  success?: boolean;
}

/**
 * Health check result for all arms
 */
export interface HealthCheckResult {
  timestamp: Date;
  armResults: Map<string, ArmAnalysis>;
  interventions: Intervention[];
  pendingPermissions: PermissionRequest[];
  summary: {
    totalArms: number;
    productive: number;
    idle: number;
    waiting: number;
    looping: number;
    silent: number;
    error: number;
  };
}

/**
 * Configuration for the health monitor
 */
export interface HealthMonitorConfig {
  /** How often to run health checks (ms) */
  checkIntervalMs: number;
  
  /** Event window size for analysis (ms) */
  eventWindowMs: number;
  
  /** How long to wait before prompting idle arms (ms) */
  idlePromptDelayMs: number;
  
  /** How long to wait before escalating stuck arms (ms) */
  stuckEscalationDelayMs: number;
  
  /** Maximum prompts to an arm before escalating */
  maxPromptsBeforeEscalation: number;
  
  /** Grace period for newly started arms (ms) */
  startupGracePeriodMs: number;
  
  /** Enable automatic interventions */
  autoInterventionEnabled: boolean;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 30 * 1000, // 30 seconds
  eventWindowMs: 10 * 60 * 1000, // 10 minutes
  idlePromptDelayMs: 2 * 60 * 1000, // 2 minutes
  stuckEscalationDelayMs: 5 * 60 * 1000, // 5 minutes
  maxPromptsBeforeEscalation: 3,
  startupGracePeriodMs: 60 * 1000, // 1 minute
  autoInterventionEnabled: true,
};

/**
 * Callbacks for the health monitor to interact with the brain
 */
export interface HealthMonitorCallbacks {
  /** Get list of active arm IDs */
  getActiveArmIds: () => Promise<string[]>;
  
  /** Send a prompt to an arm */
  sendPromptToArm: (armId: string, message: string) => Promise<void>;
  
  /** Interrupt an arm's current operation */
  interruptArm: (armId: string) => Promise<void>;
  
  /** Kill an arm */
  killArm: (armId: string, reason: string) => Promise<void>;
  
  /** Notify human of an issue */
  notifyHuman: (subject: string, body: string) => Promise<void>;
  
  /** Reply to a permission request */
  replyToPermission: (armId: string, requestId: string, approved: boolean) => Promise<void>;
}

/**
 * ArmHealthMonitor provides unified health monitoring for all arms
 */
export class ArmHealthMonitor {
  private config: HealthMonitorConfig;
  private eventWindow: BrainEventWindow;
  private analyzer: ArmActivityAnalyzer;
  private permissionEngine: PermissionDecisionEngine;
  private callbacks: HealthMonitorCallbacks;
  private logFn: (msg: string) => void;
  private db: Database | null = null;
  
  // Tracking state
  private promptCounts: Map<string, number> = new Map();
  private lastPromptTime: Map<string, Date> = new Map();
  private lastInterventions: Map<string, Intervention> = new Map();
  
  // Running state
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(
    callbacks: HealthMonitorCallbacks,
    options?: {
      config?: Partial<HealthMonitorConfig>;
      eventWindow?: BrainEventWindow;
      analyzer?: ArmActivityAnalyzer;
      permissionEngine?: PermissionDecisionEngine;
      db?: Database;
      log?: (msg: string) => void;
    }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.callbacks = callbacks;
    this.eventWindow = options?.eventWindow ?? new BrainEventWindow();
    this.analyzer = options?.analyzer ?? new ArmActivityAnalyzer();
    this.permissionEngine = options?.permissionEngine ?? new PermissionDecisionEngine();
    this.db = options?.db ?? null;
    this.logFn = options?.log ?? console.log;
  }

  /**
   * Start the periodic health monitoring
   */
  start(): void {
    if (this.isRunning) {
      return;
    }
    
    this.isRunning = true;
    this.logFn("[HealthMonitor] Starting health monitoring");
    
    // Run immediately, then on interval
    this.runHealthCheck().catch((err) => {
      this.logFn(`[HealthMonitor] Initial check failed: ${err}`);
    });
    
    this.checkTimer = setInterval(() => {
      this.runHealthCheck().catch((err) => {
        this.logFn(`[HealthMonitor] Health check failed: ${err}`);
      });
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the periodic health monitoring
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }
    
    this.isRunning = false;
    
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    
    this.logFn("[HealthMonitor] Stopped health monitoring");
  }

  /**
   * Run a single health check cycle
   */
  async runHealthCheck(): Promise<HealthCheckResult> {
    const timestamp = new Date();
    const armIds = await this.callbacks.getActiveArmIds();
    
    if (armIds.length === 0) {
      return this.emptyResult(timestamp);
    }
    
    // Fetch event windows for all arms
    const windows = await this.eventWindow.getWindowsForAllArms(armIds, {
      windowMs: this.config.eventWindowMs,
    });
    
    // Analyze each arm
    const armResults = this.analyzer.analyzeAll(windows);
    
    // Process results and take actions
    const interventions: Intervention[] = [];
    const pendingPermissions: PermissionRequest[] = [];
    
    for (const [armId, analysis] of armResults) {
      // Check for pending permissions
      if (analysis.pendingPermission) {
        const permRequest: PermissionRequest = {
          armId,
          requestId: `perm-${armId}-${Date.now()}`,
          action: analysis.pendingPermission.action,
          context: analysis.pendingPermission.context,
          requestedAt: analysis.pendingPermission.requestedAt,
        };
        pendingPermissions.push(permRequest);
        
        // Auto-process if possible
        await this.handlePermission(permRequest);
      }
      
      // Determine and execute intervention
      if (this.config.autoInterventionEnabled && analysis.recommendedAction !== "none") {
        const intervention = await this.executeIntervention(armId, analysis);
        if (intervention) {
          interventions.push(intervention);
        }
      }
    }
    
    // Build summary
    const summary = this.buildSummary(armResults);
    
    // Log result
    this.logFn(
      `[HealthMonitor] Check complete: ${summary.totalArms} arms, ` +
      `${summary.productive} productive, ${summary.idle} idle, ` +
      `${summary.looping} looping, ${summary.silent} silent, ` +
      `${interventions.length} interventions`
    );
    
    // Publish health check event
    await this.publishHealthCheckEvent(timestamp, summary, interventions);
    
    return {
      timestamp,
      armResults,
      interventions,
      pendingPermissions,
      summary,
    };
  }

  /**
   * Handle a pending permission request
   */
  private async handlePermission(request: PermissionRequest): Promise<void> {
    try {
      const decision = await this.permissionEngine.evaluate(request);
      
      if (decision.decision !== "escalate") {
        // Auto-respond
        await this.callbacks.replyToPermission(
          request.armId,
          request.requestId,
          decision.decision === "approve"
        );
      }
    } catch (err) {
      this.logFn(`[HealthMonitor] Permission handling failed: ${err}`);
    }
  }

  /**
   * Execute an intervention based on analysis
   */
  private async executeIntervention(
    armId: string,
    analysis: ArmAnalysis
  ): Promise<Intervention | null> {
    const action = analysis.recommendedAction;
    
    if (!action || action === "none") {
      return null;
    }
    
    // Check if we recently intervened
    const lastIntervention = this.lastInterventions.get(armId);
    if (lastIntervention) {
      const timeSince = Date.now() - lastIntervention.timestamp.getTime();
      if (timeSince < 60 * 1000) {
        // Don't intervene more than once per minute
        return null;
      }
    }
    
    const intervention: Intervention = {
      armId,
      type: action,
      reason: analysis.reason,
      state: analysis.state,
      timestamp: new Date(),
    };
    
    try {
      switch (action) {
        case "prompt":
          await this.handlePromptIntervention(armId, analysis);
          break;
          
        case "interrupt":
          await this.callbacks.interruptArm(armId);
          break;
          
        case "kill":
          await this.callbacks.killArm(armId, analysis.reason);
          break;
          
        case "escalate":
          await this.handleEscalation(armId, analysis);
          break;
      }
      
      intervention.success = true;
    } catch (err) {
      intervention.success = false;
      this.logFn(`[HealthMonitor] Intervention failed for ${armId}: ${err}`);
    }
    
    // Track intervention
    this.lastInterventions.set(armId, intervention);
    
    // Publish intervention event
    await this.publishInterventionEvent(intervention);
    
    return intervention;
  }

  /**
   * Handle prompting an arm
   */
  private async handlePromptIntervention(
    armId: string,
    analysis: ArmAnalysis
  ): Promise<void> {
    const promptCount = (this.promptCounts.get(armId) || 0) + 1;
    this.promptCounts.set(armId, promptCount);
    this.lastPromptTime.set(armId, new Date());
    
    // If we've prompted too many times, escalate instead
    if (promptCount > this.config.maxPromptsBeforeEscalation) {
      await this.handleEscalation(armId, analysis);
      return;
    }
    
    // Generate appropriate prompt based on state
    const message = this.generatePromptMessage(armId, analysis, promptCount);
    await this.callbacks.sendPromptToArm(armId, message);
  }

  /**
   * Generate a prompt message for an arm
   */
  private generatePromptMessage(
    armId: string,
    analysis: ArmAnalysis,
    promptCount: number
  ): string {
    switch (analysis.state) {
      case "idle":
        return `You appear to be idle. Do you have work to do? If you're blocked, please let me know what's blocking you.`;
        
      case "silent":
        return `I haven't seen any activity from you in a while. Are you still working? Please confirm you're active.`;
        
      case "looping":
        return `It looks like you might be stuck in a loop (${analysis.loopPattern?.repetitions} repetitions detected). ` +
          `Consider trying a different approach. If you need help, use the MCP tools to request assistance.`;
        
      case "waiting_permission":
        return `You're waiting for permission. The brain is processing your request.`;
        
      case "error":
        return `An error was detected. Please check your current state and report any issues using the status_report MCP tool.`;
        
      default:
        if (promptCount > 1) {
          return `This is prompt #${promptCount}. Please respond to confirm you're making progress.`;
        }
        return `How's your work going? Please provide a brief status update.`;
    }
  }

  /**
   * Handle escalation to human
   */
  private async handleEscalation(
    armId: string,
    analysis: ArmAnalysis
  ): Promise<void> {
    const subject = `[coleo] Arm ${armId} needs attention: ${analysis.state}`;
    
    let body = `The arm "${armId}" requires human attention.\n\n`;
    body += `**State:** ${analysis.state}\n`;
    body += `**Reason:** ${analysis.reason}\n`;
    body += `**Confidence:** ${analysis.confidence}\n\n`;
    
    if (analysis.loopPattern) {
      body += `**Loop Pattern:** ${analysis.loopPattern.pattern.join(" -> ")}\n`;
      body += `**Repetitions:** ${analysis.loopPattern.repetitions}\n\n`;
    }
    
    if (analysis.pendingPermission) {
      body += `**Pending Permission:**\n`;
      body += `  Action: ${analysis.pendingPermission.action}\n`;
      body += `  Waiting since: ${analysis.pendingPermission.requestedAt.toISOString()}\n\n`;
    }
    
    body += `**Metrics:**\n`;
    body += `  Events in window: ${analysis.metrics.eventCount}\n`;
    body += `  Silent for: ${Math.round(analysis.metrics.silentDurationMs / 1000)}s\n`;
    body += `  Recent messages: ${analysis.metrics.recentMessageCount}\n`;
    body += `  Recent file edits: ${analysis.metrics.recentFileEditCount}\n`;
    
    await this.callbacks.notifyHuman(subject, body);
    
    // Reset prompt count after escalation
    this.promptCounts.set(armId, 0);
  }

  /**
   * Build summary from arm results
   */
  private buildSummary(armResults: Map<string, ArmAnalysis>): HealthCheckResult["summary"] {
    const summary = {
      totalArms: armResults.size,
      productive: 0,
      idle: 0,
      waiting: 0,
      looping: 0,
      silent: 0,
      error: 0,
    };
    
    for (const analysis of armResults.values()) {
      switch (analysis.state) {
        case "productive":
        case "starting":
          summary.productive++;
          break;
        case "idle":
          summary.idle++;
          break;
        case "waiting_permission":
          summary.waiting++;
          break;
        case "looping":
          summary.looping++;
          break;
        case "silent":
          summary.silent++;
          break;
        case "error":
          summary.error++;
          break;
      }
    }
    
    return summary;
  }

  /**
   * Create an empty result
   */
  private emptyResult(timestamp: Date): HealthCheckResult {
    return {
      timestamp,
      armResults: new Map(),
      interventions: [],
      pendingPermissions: [],
      summary: {
        totalArms: 0,
        productive: 0,
        idle: 0,
        waiting: 0,
        looping: 0,
        silent: 0,
        error: 0,
      },
    };
  }

  /**
   * Publish health check event to JetStream
   */
  private async publishHealthCheckEvent(
    timestamp: Date,
    summary: HealthCheckResult["summary"],
    interventions: Intervention[]
  ): Promise<void> {
    if (!eventStore.isInitialized()) {
      return;
    }
    
    try {
      await eventStore.publishEvent("octopai.events.brain.health_check", {
        type: "health_check",
        data: {
          ...summary,
          interventionCount: interventions.length,
          interventions: interventions.map((i) => ({
            armId: i.armId,
            type: i.type,
            state: i.state,
            success: i.success,
          })),
        },
        timestamp: timestamp.toISOString(),
      });
    } catch (err) {
      this.logFn(`[HealthMonitor] Failed to publish health check event: ${err}`);
    }
  }

  /**
   * Publish intervention event to JetStream
   */
  private async publishInterventionEvent(intervention: Intervention): Promise<void> {
    if (!eventStore.isInitialized()) {
      return;
    }
    
    try {
      await eventStore.publishEvent(
        `octopai.events.arm.${intervention.armId}.intervention`,
        {
          type: "intervention",
          armId: intervention.armId,
          data: {
            interventionType: intervention.type,
            reason: intervention.reason,
            state: intervention.state,
            success: intervention.success,
          },
          timestamp: intervention.timestamp.toISOString(),
        }
      );
    } catch (err) {
      this.logFn(`[HealthMonitor] Failed to publish intervention event: ${err}`);
    }
  }

  /**
   * Get the current state of all monitored arms
   */
  getArmStates(): Map<string, {
    lastAnalysis?: ArmAnalysis;
    lastIntervention?: Intervention;
    promptCount: number;
    lastPromptTime?: Date;
  }> {
    const states = new Map<string, {
      lastAnalysis?: ArmAnalysis;
      lastIntervention?: Intervention;
      promptCount: number;
      lastPromptTime?: Date;
    }>();
    
    // Combine all tracking data
    const allArmIds = new Set([
      ...this.promptCounts.keys(),
      ...this.lastInterventions.keys(),
    ]);
    
    for (const armId of allArmIds) {
      states.set(armId, {
        lastIntervention: this.lastInterventions.get(armId),
        promptCount: this.promptCounts.get(armId) || 0,
        lastPromptTime: this.lastPromptTime.get(armId),
      });
    }
    
    return states;
  }

  /**
   * Reset tracking for an arm (e.g., when arm is killed/restarted)
   */
  resetArm(armId: string): void {
    this.promptCounts.delete(armId);
    this.lastPromptTime.delete(armId);
    this.lastInterventions.delete(armId);
    this.analyzer.resetArm(armId);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<HealthMonitorConfig>): void {
    const wasRunning = this.isRunning;
    
    // Stop if interval changed
    if (config.checkIntervalMs && config.checkIntervalMs !== this.config.checkIntervalMs) {
      this.stop();
    }
    
    this.config = { ...this.config, ...config };
    
    // Restart if was running and interval changed
    if (wasRunning && config.checkIntervalMs) {
      this.start();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): HealthMonitorConfig {
    return { ...this.config };
  }

  /**
   * Check if monitor is running
   */
  isMonitoring(): boolean {
    return this.isRunning;
  }
}
