/**
 * ArmActivityAnalyzer - Classifies arm states based on event windows
 *
 * Uses BrainEventWindow data to classify each arm as:
 * - productive: actively doing useful work
 * - idle: waiting for work
 * - waiting_permission: blocked on a permission request
 * - looping: stuck in a repetitive pattern
 * - silent: no events for an extended period
 * - error: encountered an error state
 */

import { readFile } from "fs/promises";
import { join } from "path";
import nunjucks from "nunjucks";
import type { ArmEventWindow } from "./event-window";
import type { EventData } from "../nats/jetstream";

/**
 * Classification of arm activity state
 */
export type ArmActivityState =
  | "productive"
  | "idle"
  | "waiting_permission"
  | "looping"
  | "silent"
  | "error"
  | "starting";

/**
 * Detailed analysis result for an arm
 */
export interface ArmAnalysis {
  armId: string;
  state: ArmActivityState;
  confidence: "high" | "medium" | "low";
  reason: string;
  
  /** Metrics used in the analysis */
  metrics: {
    eventCount: number;
    silentDurationMs: number;
    lastEventAt: Date | null;
    recentMessageCount: number;
    recentToolCount: number;
    recentFileEditCount: number;
  };
  
  /** If waiting for permission, details about the request */
  pendingPermission?: {
    requestedAt: Date;
    action: string;
    context?: string;
  };
  
  /** If looping, details about the pattern */
  loopPattern?: {
    pattern: string[];
    repetitions: number;
  };
  
  /** Recommended action for the brain */
  recommendedAction?: "none" | "prompt" | "interrupt" | "kill" | "escalate";
  
  /** Unknown event types encountered */
  unknownEventTypes: string[];
}

/**
 * Configuration for the analyzer
 */
export interface AnalyzerConfig {
  /** How long without events before arm is considered silent (ms) */
  silentThresholdMs: number;
  
  /** Minimum events to consider arm productive */
  productiveEventThreshold: number;
  
  /** How many repetitions before considering arm looping */
  loopRepetitionThreshold: number;
  
  /** How long to wait before escalating permission requests (ms) */
  permissionEscalationMs: number;
  
  /** Grace period for newly started arms (ms) */
  startupGracePeriodMs: number;
}

const DEFAULT_CONFIG: AnalyzerConfig = {
  silentThresholdMs: 5 * 60 * 1000, // 5 minutes
  productiveEventThreshold: 3,
  loopRepetitionThreshold: 4,
  permissionEscalationMs: 2 * 60 * 1000, // 2 minutes
  startupGracePeriodMs: 60 * 1000, // 1 minute
};

const resolveLogFn = (log?: (msg: string) => void) => log ?? console.log;

/**
 * Event types that indicate productive work
 */
const PRODUCTIVE_EVENT_TYPES = new Set([
  "file.edited",
  "message.updated",
  "command.executed",
  "todo.updated",
  "task.claimed",
  "task.completed",
  "session.diff",
]);

/**
 * Event types that indicate the arm is actively working (but may not have output yet)
 */
const ACTIVE_EVENT_TYPES = new Set([
  "session.status",
  "session.updated",
  "message.part.updated",
  "arm.heartbeat",
  "file.read",
  "file.reads",
]);

/**
 * Event types that indicate errors
 */
const ERROR_EVENT_TYPES = new Set([
  "session.error",
  "task.failed",
]);

/**
 * ArmActivityAnalyzer classifies arm states based on event windows
 */
export class ArmActivityAnalyzer {
  private config: AnalyzerConfig;
  private logFn: (msg: string) => void;
  
  // Track when arms were first seen (for grace period)
  private armFirstSeen: Map<string, Date> = new Map();
  
  // Track previous states for trend detection
  private previousStates: Map<string, ArmActivityState[]> = new Map();

  constructor(options?: {
    config?: Partial<AnalyzerConfig>;
    log?: (msg: string) => void;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.logFn = resolveLogFn(options?.log);
  }

  /**
   * Analyze an arm's activity based on its event window
   */
  analyze(window: ArmEventWindow): ArmAnalysis {
    const armId = window.armId;
    
    // Track first seen for grace period
    if (!this.armFirstSeen.has(armId)) {
      this.armFirstSeen.set(armId, new Date());
    }
    
    // Calculate basic metrics
    const metrics = this.calculateMetrics(window);
    
    // Check for unknown event types and log warnings
    const unknownEventTypes = window.unknownEventTypes;
    for (const eventType of unknownEventTypes) {
      this.logFn(
        `[Analyzer] Unknown event type "${eventType}" for arm ${armId}. ` +
        `Add classification to improve analysis accuracy.`
      );
    }
    
    // Determine state through a priority-based decision tree
    const analysis = this.classifyState(window, metrics);
    
    // Track state history
    const history = this.previousStates.get(armId) || [];
    history.push(analysis.state);
    if (history.length > 10) history.shift();
    this.previousStates.set(armId, history);
    
    return {
      ...analysis,
      armId,
      metrics,
      unknownEventTypes,
    };
  }

  /**
   * Analyze multiple arms at once
   */
  analyzeAll(windows: Map<string, ArmEventWindow>): Map<string, ArmAnalysis> {
    const results = new Map<string, ArmAnalysis>();
    
    for (const [armId, window] of windows) {
      results.set(armId, this.analyze(window));
    }
    
    return results;
  }

  /**
   * Calculate metrics from an event window
   */
  private calculateMetrics(window: ArmEventWindow): ArmAnalysis["metrics"] {
    const recentMessageCount = (window.byType.get("message.updated")?.length || 0) +
      (window.byType.get("message.part.updated")?.length || 0);
    
    const recentToolCount = window.events.filter(
      (e) => e.type === "message.part.updated" && 
             (e.data as Record<string, unknown>)?.partType === "tool-invocation"
    ).length;
    
    const recentFileEditCount = window.byType.get("file.edited")?.length || 0;
    
    return {
      eventCount: window.events.length,
      silentDurationMs: window.silentDurationMs,
      lastEventAt: window.lastEventAt,
      recentMessageCount,
      recentToolCount,
      recentFileEditCount,
    };
  }

  /**
   * Classify the arm state based on event window and metrics
   */
  private classifyState(
    window: ArmEventWindow,
    metrics: ArmAnalysis["metrics"]
  ): Omit<ArmAnalysis, "armId" | "metrics" | "unknownEventTypes"> {
    const armId = window.armId;
    
    // Check 1: Is this a newly started arm in grace period?
    const firstSeen = this.armFirstSeen.get(armId);
    if (firstSeen) {
      const timeSinceFirstSeen = Date.now() - firstSeen.getTime();
      if (timeSinceFirstSeen < this.config.startupGracePeriodMs) {
        return {
          state: "starting",
          confidence: "high",
          reason: "Arm is in startup grace period",
          recommendedAction: "none",
        };
      }
    }
    
    // Check 2: Is the arm completely silent?
    if (
      window.events.length === 0 ||
      window.silentDurationMs > this.config.silentThresholdMs
    ) {
      return {
        state: "silent",
        confidence: "high",
        reason: `No events for ${Math.round(window.silentDurationMs / 1000)}s`,
        recommendedAction: "prompt",
      };
    }
    
    // Check 3: Is there an error state?
    const hasError = window.events.some((e) => ERROR_EVENT_TYPES.has(e.type));
    if (hasError) {
      const errorEvent = window.events.find((e) => ERROR_EVENT_TYPES.has(e.type));
      return {
        state: "error",
        confidence: "high",
        reason: `Error event detected: ${errorEvent?.type}`,
        recommendedAction: "escalate",
      };
    }
    
    // Check 4: Is the arm waiting for permission?
    const permissionCheck = this.checkPendingPermission(window);
    if (permissionCheck.pending) {
      const waitingMs = permissionCheck.waitingMs || 0;
      const shouldEscalate = waitingMs > this.config.permissionEscalationMs;
      
      return {
        state: "waiting_permission",
        confidence: "high",
        reason: `Waiting for permission for ${Math.round(waitingMs / 1000)}s`,
        recommendedAction: shouldEscalate ? "escalate" : "none",
        pendingPermission: {
          requestedAt: permissionCheck.requestedAt!,
          action: permissionCheck.action || "unknown",
          context: permissionCheck.context,
        },
      };
    }
    
    // Check 5: Is the arm stuck in a loop?
    const loopCheck = this.detectLoop(window);
    if (loopCheck.detected && loopCheck.pattern && loopCheck.repetitions) {
      return {
        state: "looping",
        confidence: loopCheck.confidence,
        reason: `Detected ${loopCheck.repetitions} repetitions of pattern`,
        recommendedAction: loopCheck.repetitions > 6 ? "interrupt" : "prompt",
        loopPattern: {
          pattern: loopCheck.pattern,
          repetitions: loopCheck.repetitions,
        },
      };
    }
    
    // Check 6: Is the arm actively producing work?
    const productiveEvents = window.events.filter((e) =>
      PRODUCTIVE_EVENT_TYPES.has(e.type)
    );
    
    if (productiveEvents.length >= this.config.productiveEventThreshold) {
      return {
        state: "productive",
        confidence: "high",
        reason: `${productiveEvents.length} productive events in window`,
        recommendedAction: "none",
      };
    }
    
    // Check 7: Is the arm showing any activity at all?
    const activeEvents = window.events.filter((e) =>
      ACTIVE_EVENT_TYPES.has(e.type) || PRODUCTIVE_EVENT_TYPES.has(e.type)
    );
    
    if (activeEvents.length > 0) {
      return {
        state: "productive",
        confidence: "medium",
        reason: `${activeEvents.length} active events (processing)`,
        recommendedAction: "none",
      };
    }
    
    // Default: Idle
    return {
      state: "idle",
      confidence: "medium",
      reason: "No productive activity detected",
      recommendedAction: "prompt",
    };
  }

  /**
   * Check for pending permission requests
   */
  private checkPendingPermission(window: ArmEventWindow): {
    pending: boolean;
    requestedAt?: Date;
    waitingMs?: number;
    action?: string;
    context?: string;
  } {
    const askedEvents = window.byType.get("permission.asked") || [];
    const repliedEvents = window.byType.get("permission.replied") || [];
    
    if (askedEvents.length === 0) {
      return { pending: false };
    }
    
    // Get the most recent of each
    const latestAsked = this.getLatestEvent(askedEvents);
    const latestReplied = this.getLatestEvent(repliedEvents);
    
    if (!latestAsked) {
      return { pending: false };
    }
    
    const askedTime = new Date(latestAsked.timestamp);
    
    // If no reply or reply is older than ask, permission is pending
    if (
      !latestReplied ||
      new Date(latestReplied.timestamp) < askedTime
    ) {
      const data = latestAsked.data as Record<string, unknown>;
      return {
        pending: true,
        requestedAt: askedTime,
        waitingMs: Date.now() - askedTime.getTime(),
        action: (data.action as string) || (data.tool as string) || "unknown",
        context: data.context as string | undefined,
      };
    }
    
    return { pending: false };
  }

  /**
   * Detect stuck loops in event patterns
   */
  private detectLoop(window: ArmEventWindow): {
    detected: boolean;
    confidence: "high" | "medium" | "low";
    pattern?: string[];
    repetitions?: number;
  } {
    if (window.events.length < this.config.loopRepetitionThreshold * 2) {
      return { detected: false, confidence: "low" };
    }
    
    // Look at recent event types
    const recentTypes = window.events.slice(-30).map((e) => e.type);
    
    // Try to find repeating patterns of length 1-5
    for (let patternLength = 1; patternLength <= 5; patternLength++) {
      if (recentTypes.length < patternLength * this.config.loopRepetitionThreshold) {
        continue;
      }
      
      const pattern = recentTypes.slice(-patternLength);
      let repetitions = 0;
      
      for (
        let i = recentTypes.length - patternLength;
        i >= 0;
        i -= patternLength
      ) {
        const slice = recentTypes.slice(i, i + patternLength);
        if (this.arraysEqual(slice, pattern)) {
          repetitions++;
        } else {
          break;
        }
      }
      
      if (repetitions >= this.config.loopRepetitionThreshold) {
        const confidence = repetitions >= 6 ? "high" : repetitions >= 4 ? "medium" : "low";
        return {
          detected: true,
          confidence,
          pattern,
          repetitions,
        };
      }
    }
    
    return { detected: false, confidence: "low" };
  }

  /**
   * Get the latest event from an array
   */
  private getLatestEvent(events: EventData[]): EventData | null {
    if (events.length === 0) return null;
    
    let latest = events[0]!;
    for (const event of events) {
      if (new Date(event.timestamp) > new Date(latest.timestamp)) {
        latest = event;
      }
    }
    return latest;
  }

  /**
   * Check if two arrays are equal
   */
  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Get trend for an arm based on state history
   */
  getStateTrend(armId: string): {
    improving: boolean;
    degrading: boolean;
    stable: boolean;
    history: ArmActivityState[];
  } {
    const history = this.previousStates.get(armId) || [];
    
    if (history.length < 3) {
      return { improving: false, degrading: false, stable: true, history };
    }
    
    // Simple trend: compare first half to second half
    const midpoint = Math.floor(history.length / 2);
    const firstHalf = history.slice(0, midpoint);
    const secondHalf = history.slice(midpoint);
    
    const stateScore = (state: ArmActivityState): number => {
      switch (state) {
        case "productive": return 3;
        case "idle": return 2;
        case "starting": return 2;
        case "waiting_permission": return 1;
        case "looping": return 0;
        case "silent": return -1;
        case "error": return -2;
      }
    };
    
    const avgFirst = firstHalf.reduce((sum, s) => sum + stateScore(s), 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((sum, s) => sum + stateScore(s), 0) / secondHalf.length;
    
    const improving = avgSecond > avgFirst + 0.5;
    const degrading = avgSecond < avgFirst - 0.5;
    
    return {
      improving,
      degrading,
      stable: !improving && !degrading,
      history,
    };
  }

  /**
   * Reset tracking state for an arm
   */
  resetArm(armId: string): void {
    this.armFirstSeen.delete(armId);
    this.previousStates.delete(armId);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AnalyzerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): AnalyzerConfig {
    return { ...this.config };
  }
}

/**
 * Stuck Arm Analysis Result
 */
export interface StuckAnalysis {
  isStuck: boolean;
  stuckType?: "asking_question" | "waiting_approval" | "looping" | "error" | "idle_too_long" | "unknown";
  reasoning: string;
  suggestedAction?: "answer" | "approve" | "restart" | "compact" | "escalate" | "prompt";
  suggestedResponse?: string;
  confidence: number; // 0-1
}

/**
 * LLM-based Stuck Arm Analyzer
 * Analyzes PTY output to determine if an arm is stuck and suggests actions
 */
export class StuckArmAnalyzer {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private logger: (message: string) => void;
  private templateDir: string;

  constructor(logger: (message: string) => void, coleoDir: string = process.cwd()) {
    this.logger = resolveLogFn(logger);
    this.apiKey = process.env.OPENAI_API_KEY || "";
    this.model = process.env.OPENAI_MODEL || "gpt-5-mini";
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    this.templateDir = join(coleoDir, "src", "brain", "templates");
  }

  private async renderTemplate(
    templateName: string,
    context: Record<string, unknown>
  ): Promise<string | null> {
    const templatePath = join(this.templateDir, templateName);
    try {
      const templateContent = await readFile(templatePath, "utf-8");
      return nunjucks.renderString(templateContent, context);
    } catch (err) {
      this.logger(`[stuck-analyzer] Failed to load template ${templateName}: ${err}`);
      return null;
    }
  }

  /**
   * Analyze arm output to determine if it's stuck
   */
  async analyze(
    armName: string,
    armDomain: string,
    recentOutput: string,
    currentTask?: string
  ): Promise<StuckAnalysis> {
    // Quick heuristics first (avoid LLM calls when possible)
    const quickResult = this.quickAnalysis(recentOutput);
    if (quickResult) {
      return quickResult;
    }

    // Use LLM for deeper analysis
    if (!this.apiKey) {
      return this.fallbackAnalysis(recentOutput);
    }

    const systemPrompt = await this.renderTemplate("stuck-analyzer-system-prompt.jinja", {
      arm_name: armName,
      arm_domain: armDomain,
      current_task: currentTask || "unknown",
    });

    const userMessage = await this.renderTemplate("stuck-analyzer-user-prompt.jinja", {
      recent_output: recentOutput.slice(-8000),
    });

    if (!systemPrompt || !userMessage) {
      return this.fallbackAnalysis(recentOutput);
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.2,
          max_completion_tokens: 500,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        this.logger(`[stuck-analyzer] OpenAI API error: ${err.substring(0, 200)}`);
        return this.fallbackAnalysis(recentOutput);
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      const content = data.choices[0]?.message?.content || "";

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]) as StuckAnalysis;
        this.logger(`[stuck-analyzer] LLM analysis for ${armName}: stuck=${result.isStuck}, type=${result.stuckType}, confidence=${result.confidence}`);
        return result;
      }

      return this.fallbackAnalysis(recentOutput);
    } catch (err) {
      this.logger(`[stuck-analyzer] LLM analysis error: ${err}`);
      return this.fallbackAnalysis(recentOutput);
    }
  }

  /**
   * Quick heuristic analysis (avoids LLM call)
   */
  private quickAnalysis(output: string): StuckAnalysis | null {
    const lines = output.trim().split("\n");
    const lastLines = lines.slice(-20).join("\n").toLowerCase();

    // Check for obvious question patterns
    // Only match patterns that indicate the arm is truly waiting for input, not just
    // generating text that happens to contain question-like phrases
    const questionPatterns = [
      /\?\s*$/m,  // Line ends with ?
      /\(y\/n\)\s*$/mi,  // (y/n) at end of line
      /\[y\/n\]\s*$/mi,  // [y/n] at end of line
      /yes or no\?/i,
      /please (choose|select|confirm|specify)\b/i,
      // Only match "enter:" at the very end of output, preceded by a prompt-like pattern
      /[>$\#]\s*enter\s*:/i,
      /^\s*enter\s*:/im,  // "Enter:" at start of a line (after whitespace)
    ];

    for (const pattern of questionPatterns) {
      if (pattern.test(lastLines)) {
        return {
          isStuck: true,
          stuckType: "asking_question",
          reasoning: `Output matches question pattern: ${pattern}`,
          suggestedAction: "answer",
          confidence: 0.8,
        };
      }
    }

    // Check for approval patterns
    const approvalPatterns = [
      /approve.*\?/i,
      /proceed.*\?/i,
      /continue.*\?/i,
      /confirm.*\?/i,
    ];

    for (const pattern of approvalPatterns) {
      if (pattern.test(lastLines)) {
        return {
          isStuck: true,
          stuckType: "waiting_approval",
          reasoning: `Output matches approval pattern: ${pattern}`,
          suggestedAction: "approve",
          suggestedResponse: "Yes, proceed.",
          confidence: 0.85,
        };
      }
    }

    // Check for repeated errors (looping)
    const errorCounts = new Map<string, number>();
    for (const line of lines.slice(-50)) {
      if (/error|failed|exception/i.test(line)) {
        const normalized = line.toLowerCase().replace(/\d+/g, "N").trim();
        errorCounts.set(normalized, (errorCounts.get(normalized) || 0) + 1);
      }
    }

    for (const [error, count] of errorCounts) {
      if (count >= 3) {
        return {
          isStuck: true,
          stuckType: "looping",
          reasoning: `Same error repeated ${count} times: ${error.slice(0, 50)}...`,
          suggestedAction: "compact",
          confidence: 0.75,
        };
      }
    }

    return null; // Need deeper analysis
  }

  /**
   * Fallback analysis when LLM is unavailable
   */
  private fallbackAnalysis(output: string): StuckAnalysis {
    const lines = output.trim().split("\n");
    const lastLine = lines[lines.length - 1] || "";

    // Very basic heuristics
    if (lastLine.includes("?") || lastLine.toLowerCase().includes("input")) {
      return {
        isStuck: true,
        stuckType: "asking_question",
        reasoning: "Last line appears to be a question (fallback)",
        suggestedAction: "escalate",
        confidence: 0.5,
      };
    }

    // If output is very short or empty, might be idle
    if (output.trim().length < 100) {
      return {
        isStuck: false,
        reasoning: "Output too short to determine (fallback)",
        confidence: 0.3,
      };
    }

    return {
      isStuck: false,
      reasoning: "No obvious stuck patterns detected (fallback)",
      confidence: 0.4,
    };
  }
}

// Export default instance
export const armActivityAnalyzer = new ArmActivityAnalyzer();
