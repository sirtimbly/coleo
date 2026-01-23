/**
 * PermissionDecisionEngine - Rule-based handler for permission.asked events
 *
 * Implements security policies from docs/architecture/security.md:
 * - Auto-approves safe operations (read-only, known-safe patterns)
 * - Auto-denies dangerous operations (destructive commands, secret leaks)
 * - Escalates ambiguous cases to human
 *
 * Each decision produces an auditable event back into JetStream.
 */

import { eventStore, type EventData } from "../nats/jetstream";

/**
 * Permission request from an arm
 */
export interface PermissionRequest {
  armId: string;
  requestId: string;
  action: string;
  tool?: string;
  command?: string;
  file?: string;
  context?: string;
  requestedAt: Date;
}

/**
 * Permission decision result
 */
export interface PermissionDecision {
  requestId: string;
  armId: string;
  decision: "approve" | "deny" | "escalate";
  reason: string;
  ruleMatched?: string;
  respondedAt: Date;
}

/**
 * Permission rule definition
 */
export interface PermissionRule {
  id: string;
  name: string;
  description: string;
  
  /** What this rule matches */
  match: {
    tools?: string[];
    actions?: string[];
    commandPatterns?: RegExp[];
    filePatterns?: RegExp[];
  };
  
  /** What decision to make when matched */
  decision: "approve" | "deny" | "escalate";
  
  /** Priority: higher numbers take precedence */
  priority: number;
}

/**
 * Configuration for the permission engine
 */
export interface PermissionEngineConfig {
  /** Whether to enable auto-approval for safe operations */
  autoApproveEnabled: boolean;
  
  /** Whether to enable auto-denial for dangerous operations */
  autoDenyEnabled: boolean;
  
  /** Maximum time to wait before escalating (ms) */
  escalationTimeoutMs: number;
  
  /** Rate limit: max approvals per arm per minute */
  maxApprovalsPerMinute: number;
  
  /** Custom rules to add */
  customRules?: PermissionRule[];
}

const DEFAULT_CONFIG: PermissionEngineConfig = {
  autoApproveEnabled: true,
  autoDenyEnabled: true,
  escalationTimeoutMs: 2 * 60 * 1000, // 2 minutes
  maxApprovalsPerMinute: 30,
};

/**
 * Built-in permission rules based on security.md
 */
const BUILTIN_RULES: PermissionRule[] = [
  // ===== DENY RULES (highest priority) =====
  
  // Destructive filesystem commands
  {
    id: "deny-rm-rf",
    name: "Block rm -rf",
    description: "Block recursive forced deletion",
    match: {
      commandPatterns: [
        /rm\s+(-rf?|--recursive)\s+\//,
        /rm\s+(-rf?|--recursive)\s+~\//,
        /rm\s+(-rf?|--recursive)\s+\.\.\//,
      ],
    },
    decision: "deny",
    priority: 1000,
  },
  
  // Force push to main/master
  {
    id: "deny-force-push-main",
    name: "Block force push to main",
    description: "Block git force push to main/master",
    match: {
      commandPatterns: [
        /git\s+push\s+.*--force\s+.*main/,
        /git\s+push\s+.*--force\s+.*master/,
        /git\s+push\s+-f\s+.*main/,
        /git\s+push\s+-f\s+.*master/,
      ],
    },
    decision: "deny",
    priority: 1000,
  },
  
  // Database destruction
  {
    id: "deny-db-destruction",
    name: "Block database destruction",
    description: "Block DROP/TRUNCATE/DELETE without WHERE",
    match: {
      commandPatterns: [
        /DROP\s+(DATABASE|TABLE|SCHEMA)/i,
        /TRUNCATE\s+TABLE/i,
        /DELETE\s+FROM\s+\w+\s*(;|$)/i,
      ],
    },
    decision: "deny",
    priority: 1000,
  },
  
  // Secret exposure
  {
    id: "deny-secret-exposure",
    name: "Block secret exposure",
    description: "Block commands that might expose secrets",
    match: {
      commandPatterns: [
        /curl\s+.*\$\{?[A-Z_]*KEY/i,
        /echo\s+\$\{?[A-Z_]*SECRET/i,
        /echo\s+\$\{?[A-Z_]*PASSWORD/i,
        /echo\s+\$\{?[A-Z_]*TOKEN/i,
      ],
    },
    decision: "deny",
    priority: 1000,
  },
  
  // Exfiltration targets
  {
    id: "deny-exfiltration",
    name: "Block exfiltration",
    description: "Block requests to known exfiltration targets",
    match: {
      commandPatterns: [
        /curl.*pastebin\.com/i,
        /curl.*paste\.ee/i,
        /curl.*transfer\.sh/i,
        /curl.*file\.io/i,
        /curl.*webhook\.site/i,
        /curl.*requestbin\.com/i,
      ],
    },
    decision: "deny",
    priority: 1000,
  },
  
  // Dangerous chmod
  {
    id: "deny-chmod-777",
    name: "Block chmod 777",
    description: "Block overly permissive chmod",
    match: {
      commandPatterns: [
        /chmod\s+777/,
        /chmod\s+-R\s+777/,
      ],
    },
    decision: "deny",
    priority: 900,
  },
  
  // ===== ESCALATE RULES (medium priority) =====
  
  // Git hard reset
  {
    id: "escalate-git-reset-hard",
    name: "Escalate git reset --hard",
    description: "Require human approval for git reset --hard",
    match: {
      commandPatterns: [
        /git\s+reset\s+--hard/,
      ],
    },
    decision: "escalate",
    priority: 800,
  },
  
  // Production deployments
  {
    id: "escalate-production-deploy",
    name: "Escalate production deploys",
    description: "Require human approval for production deployments",
    match: {
      commandPatterns: [
        /deploy.*prod/i,
        /kubectl.*--namespace.*prod/i,
        /docker.*push.*prod/i,
      ],
    },
    decision: "escalate",
    priority: 800,
  },
  
  // Package publishing
  {
    id: "escalate-package-publish",
    name: "Escalate package publishing",
    description: "Require human approval for publishing packages",
    match: {
      commandPatterns: [
        /npm\s+publish/,
        /yarn\s+publish/,
        /pnpm\s+publish/,
      ],
    },
    decision: "escalate",
    priority: 800,
  },
  
  // ===== APPROVE RULES (lower priority) =====
  
  // Read-only git commands
  {
    id: "approve-git-readonly",
    name: "Approve read-only git",
    description: "Auto-approve safe git commands",
    match: {
      commandPatterns: [
        /^git\s+(status|log|diff|show|branch|remote|fetch)/,
      ],
    },
    decision: "approve",
    priority: 500,
  },
  
  // File reading tools
  {
    id: "approve-file-read",
    name: "Approve file reading",
    description: "Auto-approve file reading operations",
    match: {
      tools: ["Read", "Glob", "Grep", "read_file", "search_code"],
      actions: ["read", "search", "list"],
    },
    decision: "approve",
    priority: 500,
  },
  
  // Navigation/exploration
  {
    id: "approve-navigation",
    name: "Approve navigation",
    description: "Auto-approve filesystem navigation",
    match: {
      commandPatterns: [
        /^ls(\s|$)/,
        /^pwd$/,
        /^find\s+.*-type\s+[fd](\s|$)/,
        /^tree(\s|$)/,
      ],
    },
    decision: "approve",
    priority: 500,
  },
  
  // Package installation (not publish)
  {
    id: "approve-package-install",
    name: "Approve package install",
    description: "Auto-approve installing dependencies",
    match: {
      commandPatterns: [
        /^(npm|yarn|pnpm|bun)\s+(install|add|i)(\s|$)/,
      ],
    },
    decision: "approve",
    priority: 400,
  },
  
  // Build commands
  {
    id: "approve-build",
    name: "Approve build commands",
    description: "Auto-approve build/compile commands",
    match: {
      commandPatterns: [
        /^(npm|yarn|pnpm|bun)\s+run\s+(build|compile|typecheck)/,
        /^tsc(\s|$)/,
        /^make(\s|$)/,
      ],
    },
    decision: "approve",
    priority: 400,
  },
  
  // Test commands
  {
    id: "approve-test",
    name: "Approve test commands",
    description: "Auto-approve test execution",
    match: {
      commandPatterns: [
        /^(npm|yarn|pnpm|bun)\s+(run\s+)?test/,
        /^(jest|vitest|mocha|pytest)/,
      ],
    },
    decision: "approve",
    priority: 400,
  },
  
  // Linting
  {
    id: "approve-lint",
    name: "Approve linting",
    description: "Auto-approve linting commands",
    match: {
      commandPatterns: [
        /^(npm|yarn|pnpm|bun)\s+run\s+lint/,
        /^eslint(\s|$)/,
        /^prettier(\s|$)/,
      ],
    },
    decision: "approve",
    priority: 400,
  },
];

/**
 * PermissionDecisionEngine handles permission requests from arms
 */
export class PermissionDecisionEngine {
  private config: PermissionEngineConfig;
  private rules: PermissionRule[];
  private logFn: (msg: string) => void;
  
  // Rate limiting: track approvals per arm
  private approvalCounts: Map<string, { count: number; windowStart: Date }> = new Map();
  
  // Decision history for auditing
  private decisionHistory: PermissionDecision[] = [];
  
  // Pending escalations
  private pendingEscalations: Map<string, {
    request: PermissionRequest;
    escalatedAt: Date;
    notifiedHuman: boolean;
  }> = new Map();

  constructor(options?: {
    config?: Partial<PermissionEngineConfig>;
    log?: (msg: string) => void;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.rules = [
      ...BUILTIN_RULES,
      ...(this.config.customRules || []),
    ].sort((a, b) => b.priority - a.priority);
    this.logFn = options?.log ?? console.log;
  }

  /**
   * Evaluate a permission request and return a decision
   */
  async evaluate(request: PermissionRequest): Promise<PermissionDecision> {
    const { armId, requestId, action, tool, command, file } = request;
    
    this.logFn(`[Permission] Evaluating request ${requestId} from arm ${armId}: ${action}`);
    
    // Check rate limiting first
    if (!this.checkRateLimit(armId)) {
      return this.makeDecision(request, "deny", "Rate limit exceeded", "rate-limit");
    }
    
    // Find matching rule
    const matchedRule = this.findMatchingRule(request);
    
    if (matchedRule) {
      this.logFn(`[Permission] Rule matched: ${matchedRule.name} -> ${matchedRule.decision}`);
      
      // Check if auto-approve/deny is enabled
      if (matchedRule.decision === "approve" && !this.config.autoApproveEnabled) {
        return this.makeDecision(request, "escalate", "Auto-approve disabled", matchedRule.id);
      }
      
      if (matchedRule.decision === "deny" && !this.config.autoDenyEnabled) {
        return this.makeDecision(request, "escalate", "Auto-deny disabled, requires human review", matchedRule.id);
      }
      
      return this.makeDecision(request, matchedRule.decision, matchedRule.description, matchedRule.id);
    }
    
    // No rule matched - default to escalate
    this.logFn(`[Permission] No rule matched, escalating to human`);
    return this.makeDecision(request, "escalate", "No matching rule, requires human decision");
  }

  /**
   * Find the first matching rule for a request
   */
  private findMatchingRule(request: PermissionRequest): PermissionRule | null {
    const { action, tool, command, file } = request;
    
    for (const rule of this.rules) {
      const { match } = rule;
      
      // Check tool match
      if (match.tools && tool && match.tools.includes(tool)) {
        return rule;
      }
      
      // Check action match
      if (match.actions && action && match.actions.includes(action)) {
        return rule;
      }
      
      // Check command patterns
      if (match.commandPatterns && command) {
        for (const pattern of match.commandPatterns) {
          if (pattern.test(command)) {
            return rule;
          }
        }
      }
      
      // Check file patterns
      if (match.filePatterns && file) {
        for (const pattern of match.filePatterns) {
          if (pattern.test(file)) {
            return rule;
          }
        }
      }
    }
    
    return null;
  }

  /**
   * Create a decision and publish it
   */
  private async makeDecision(
    request: PermissionRequest,
    decision: "approve" | "deny" | "escalate",
    reason: string,
    ruleMatched?: string
  ): Promise<PermissionDecision> {
    const result: PermissionDecision = {
      requestId: request.requestId,
      armId: request.armId,
      decision,
      reason,
      ruleMatched,
      respondedAt: new Date(),
    };
    
    // Track for rate limiting
    if (decision === "approve") {
      this.incrementApprovalCount(request.armId);
    }
    
    // Track for escalation handling
    if (decision === "escalate") {
      this.pendingEscalations.set(request.requestId, {
        request,
        escalatedAt: new Date(),
        notifiedHuman: false,
      });
    }
    
    // Track in history
    this.decisionHistory.push(result);
    if (this.decisionHistory.length > 1000) {
      this.decisionHistory.shift();
    }
    
    // Publish to JetStream
    await this.publishDecision(request, result);
    
    this.logFn(
      `[Permission] Decision for ${request.requestId}: ${decision} (${reason})`
    );
    
    return result;
  }

  /**
   * Publish decision to JetStream for auditing
   */
  private async publishDecision(
    request: PermissionRequest,
    decision: PermissionDecision
  ): Promise<void> {
    if (!eventStore.isInitialized()) {
      return;
    }
    
    try {
      await eventStore.publishEvent(
        `octopai.events.arm.${request.armId}.permission_decision`,
        {
          type: "permission_decision",
          armId: request.armId,
          data: {
            requestId: request.requestId,
            action: request.action,
            tool: request.tool,
            command: request.command,
            decision: decision.decision,
            reason: decision.reason,
            ruleMatched: decision.ruleMatched,
          },
          timestamp: decision.respondedAt.toISOString(),
        }
      );
    } catch (err) {
      this.logFn(`[Permission] Failed to publish decision: ${err}`);
    }
  }

  /**
   * Check if an arm is within rate limits
   */
  private checkRateLimit(armId: string): boolean {
    const now = new Date();
    const record = this.approvalCounts.get(armId);
    
    if (!record) {
      return true;
    }
    
    // Reset window if needed
    const windowDurationMs = 60 * 1000; // 1 minute
    if (now.getTime() - record.windowStart.getTime() > windowDurationMs) {
      this.approvalCounts.set(armId, { count: 0, windowStart: now });
      return true;
    }
    
    return record.count < this.config.maxApprovalsPerMinute;
  }

  /**
   * Increment approval count for rate limiting
   */
  private incrementApprovalCount(armId: string): void {
    const now = new Date();
    const record = this.approvalCounts.get(armId);
    
    if (!record || now.getTime() - record.windowStart.getTime() > 60 * 1000) {
      this.approvalCounts.set(armId, { count: 1, windowStart: now });
    } else {
      record.count++;
    }
  }

  /**
   * Handle a human decision for an escalated request
   */
  async handleHumanDecision(
    requestId: string,
    decision: "approve" | "deny",
    reason?: string
  ): Promise<boolean> {
    const pending = this.pendingEscalations.get(requestId);
    if (!pending) {
      this.logFn(`[Permission] No pending escalation for ${requestId}`);
      return false;
    }
    
    // Remove from pending
    this.pendingEscalations.delete(requestId);
    
    // Create and publish the decision
    const result: PermissionDecision = {
      requestId,
      armId: pending.request.armId,
      decision,
      reason: reason || `Human ${decision}ed`,
      ruleMatched: "human-decision",
      respondedAt: new Date(),
    };
    
    this.decisionHistory.push(result);
    await this.publishDecision(pending.request, result);
    
    this.logFn(
      `[Permission] Human decision for ${requestId}: ${decision}`
    );
    
    return true;
  }

  /**
   * Get pending escalations that need human attention
   */
  getPendingEscalations(): Array<{
    request: PermissionRequest;
    escalatedAt: Date;
    waitingMs: number;
  }> {
    const now = Date.now();
    const results: Array<{
      request: PermissionRequest;
      escalatedAt: Date;
      waitingMs: number;
    }> = [];
    
    for (const [_requestId, pending] of this.pendingEscalations) {
      results.push({
        request: pending.request,
        escalatedAt: pending.escalatedAt,
        waitingMs: now - pending.escalatedAt.getTime(),
      });
    }
    
    return results.sort((a, b) => b.waitingMs - a.waitingMs);
  }

  /**
   * Get escalations that have exceeded timeout
   */
  getTimedOutEscalations(): Array<{
    request: PermissionRequest;
    escalatedAt: Date;
    waitingMs: number;
  }> {
    return this.getPendingEscalations().filter(
      (e) => e.waitingMs > this.config.escalationTimeoutMs
    );
  }

  /**
   * Get recent decision history
   */
  getDecisionHistory(limit: number = 50): PermissionDecision[] {
    return this.decisionHistory.slice(-limit);
  }

  /**
   * Get decision statistics
   */
  getStatistics(): {
    totalDecisions: number;
    approved: number;
    denied: number;
    escalated: number;
    pendingEscalations: number;
    ruleHitCounts: Map<string, number>;
  } {
    const ruleHitCounts = new Map<string, number>();
    let approved = 0;
    let denied = 0;
    let escalated = 0;
    
    for (const decision of this.decisionHistory) {
      switch (decision.decision) {
        case "approve":
          approved++;
          break;
        case "deny":
          denied++;
          break;
        case "escalate":
          escalated++;
          break;
      }
      
      if (decision.ruleMatched) {
        const count = ruleHitCounts.get(decision.ruleMatched) || 0;
        ruleHitCounts.set(decision.ruleMatched, count + 1);
      }
    }
    
    return {
      totalDecisions: this.decisionHistory.length,
      approved,
      denied,
      escalated,
      pendingEscalations: this.pendingEscalations.size,
      ruleHitCounts,
    };
  }

  /**
   * Add a custom rule
   */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove a rule by ID
   */
  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex((r) => r.id === ruleId);
    if (index >= 0) {
      this.rules.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Get all rules
   */
  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PermissionEngineConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Re-add custom rules if provided
    if (config.customRules) {
      this.rules = [
        ...BUILTIN_RULES,
        ...config.customRules,
      ].sort((a, b) => b.priority - a.priority);
    }
  }

  /**
   * Parse a permission event into a PermissionRequest
   */
  static parsePermissionEvent(event: EventData): PermissionRequest | null {
    if (event.type !== "permission.asked") {
      return null;
    }
    
    const data = event.data as Record<string, unknown>;
    const armId = event.armId || (data.armId as string);
    
    if (!armId) {
      return null;
    }
    
    return {
      armId,
      requestId: (data.requestId as string) || `perm-${Date.now()}`,
      action: (data.action as string) || (data.type as string) || "unknown",
      tool: data.tool as string | undefined,
      command: data.command as string | undefined,
      file: data.file as string | undefined,
      context: data.context as string | undefined,
      requestedAt: new Date(event.timestamp),
    };
  }
}

// Export default instance
export const permissionDecisionEngine = new PermissionDecisionEngine();
