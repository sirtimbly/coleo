/**
 * Brain Integration for Stopping Point Detection and Branch/PR Workflow
 * 
 * Integrates stopping point detection into the Brain's task completion flow
 * and triggers automated branch/PR workflows when appropriate.
 */

import { detectStoppingPoint, type StoppingPointCriteria, DEFAULT_CRITERIA } from "./stopping-point-detector";
import { executeBranchPRWorkflow, type BranchConfig, DEFAULT_BRANCH_CONFIG } from "./branch-pr-workflow";
import type { Task } from "../types";

export interface StoppingPointIntegrationConfig {
  /** Whether stopping point detection is enabled */
  enabled: boolean;
  /** Detection criteria */
  criteria: StoppingPointCriteria;
  /** Branch/PR workflow config */
  branchConfig: BranchConfig;
  /** Whether to auto-execute workflow or just prompt */
  autoExecute: boolean;
  /** Minimum confidence threshold for auto-execution */
  autoExecuteThreshold: number;
}

export const DEFAULT_INTEGRATION_CONFIG: StoppingPointIntegrationConfig = {
  enabled: true,
  criteria: DEFAULT_CRITERIA,
  branchConfig: DEFAULT_BRANCH_CONFIG,
  autoExecute: false,
  autoExecuteThreshold: 0.8,
};

/**
 * Analyze whether an arm has reached a good stopping point
 * Called by the Brain when processing task completion
 */
export async function analyzeStoppingPoint(
  task: Task,
  armId: string,
  completionSummary: string,
  config: StoppingPointIntegrationConfig = DEFAULT_INTEGRATION_CONFIG
): Promise<{
  shouldSuggestPR: boolean;
  analysis: {
    isGoodStoppingPoint: boolean;
    confidence: number;
    reasons: string[];
    recommendations: string[];
  } | null;
  workflowResult?: {
    success: boolean;
    branchName?: string;
    error?: string;
  };
}> {
  if (!config.enabled) {
    return { shouldSuggestPR: false, analysis: null };
  }

  try {
    // Gather git status (this would need to be passed in or fetched)
    // For now, we'll use placeholder values that would come from the arm's environment
    const gitStatus = {
      branch: "master",
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      commitsSinceLastStop: 0,
    };

    // Calculate task duration
    const taskDuration = task.updatedAt 
      ? (Date.now() - task.updatedAt.getTime()) / (1000 * 60) // minutes
      : 0;

    // Run stopping point detection
    const analysis = await detectStoppingPoint(
      task,
      gitStatus,
      null, // test status unknown at this point
      taskDuration,
      config.criteria
    );

    const shouldSuggestPR = analysis.isGoodStoppingPoint && analysis.confidence >= 0.6;

    // Auto-execute if configured and confidence is high enough
    if (shouldSuggestPR && config.autoExecute && analysis.confidence >= config.autoExecuteThreshold) {
      const workflowResult = await executeBranchPRWorkflow(
        armId,
        task.id,
        task.subject,
        config.branchConfig
      );

      return {
        shouldSuggestPR,
        analysis: {
          isGoodStoppingPoint: analysis.isGoodStoppingPoint,
          confidence: analysis.confidence,
          reasons: analysis.reasons,
          recommendations: analysis.recommendations,
        },
        workflowResult: {
          success: workflowResult.success,
          branchName: workflowResult.branchName,
          error: workflowResult.error,
        },
      };
    }

    return {
      shouldSuggestPR,
      analysis: {
        isGoodStoppingPoint: analysis.isGoodStoppingPoint,
        confidence: analysis.confidence,
        reasons: analysis.reasons,
        recommendations: analysis.recommendations,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      shouldSuggestPR: false,
      analysis: null,
      workflowResult: {
        success: false,
        error: `Stopping point analysis failed: ${message}`,
      },
    };
  }
}

/**
 * Generate a prompt for the arm when a good stopping point is detected
 */
export function generateStoppingPointPrompt(
  task: Task,
  analysis: {
    isGoodStoppingPoint: boolean;
    confidence: number;
    reasons: string[];
    recommendations: string[];
  }
): string {
  const reasonsList = analysis.reasons.map(r => `- ${r}`).join("\n");
  const recommendationsList = analysis.recommendations.map(r => `- ${r}`).join("\n");

  return `# Good Stopping Point Detected

**Task**: ${task.subject} (${task.id})

**Analysis**:
- Confidence: ${Math.round(analysis.confidence * 100)}%
- Status: Good stopping point reached

**Reasons**:
${reasonsList}

**Recommendations**:
${recommendationsList}

## Suggested Next Steps

You appear to have reached a good stopping point. Consider:

1. **Create a feature branch** to organize your work
2. **Commit your changes** with clear, descriptive messages
3. **Open a PR draft** for review

Would you like me to:
- [ ] Create a feature branch automatically
- [ ] Help organize your commits
- [ ] Generate a PR draft

Or continue working if you feel there's more to do on this task.
`;
}

/**
 * Log stopping point detection telemetry
 */
export function logStoppingPointTelemetry(
  taskId: string,
  armId: string,
  analysis: {
    isGoodStoppingPoint: boolean;
    confidence: number;
    reasons: string[];
  } | null,
  action: "detected" | "prompted" | "executed" | "declined",
  success: boolean,
  details?: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    type: "stopping_point",
    taskId,
    armId,
    action,
    success,
    confidence: analysis?.confidence || 0,
    isGoodStoppingPoint: analysis?.isGoodStoppingPoint || false,
    reasons: analysis?.reasons || [],
    details,
  };

  // Log to console (in production, this would go to a proper telemetry system)
  console.log("[STOPPING_POINT_TELEMETRY]", JSON.stringify(logEntry));
}
