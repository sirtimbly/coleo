/**
 * Stopping Point Detector
 * 
 * Detects when an arm has reached a good stopping point for creating
 * a branch, organizing commits, and submitting a PR.
 */

import type { Task } from "../types";

export interface StoppingPointCriteria {
  /** Minimum number of files changed to consider a stopping point */
  minFilesChanged: number;
  /** Maximum number of commits before forcing a stopping point */
  maxCommitsBeforeStop: number;
  /** Time threshold in minutes - force stop after this duration */
  maxDurationMinutes: number;
  /** Whether tests must pass to be a good stopping point */
  requireTestsPassing: boolean;
  /** Maximum complexity score before suggesting a stop */
  maxComplexityScore: number;
}

export interface StoppingPointAnalysis {
  isGoodStoppingPoint: boolean;
  confidence: number; // 0-1
  reasons: string[];
  recommendations: string[];
  metrics: {
    filesChanged: number;
    commits: number;
    durationMinutes: number;
    testsPassing: boolean | null;
    complexityScore: number;
    linesAdded: number;
    linesRemoved: number;
  };
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  commitsSinceLastStop: number;
}

export const DEFAULT_CRITERIA: StoppingPointCriteria = {
  minFilesChanged: 3,
  maxCommitsBeforeStop: 10,
  maxDurationMinutes: 120, // 2 hours
  requireTestsPassing: true,
  maxComplexityScore: 50,
};

/**
 * Detect if current work state represents a good stopping point
 */
export async function detectStoppingPoint(
  task: Task,
  gitStatus: GitStatus,
  testStatus: "passing" | "failing" | "not_run" | null,
  durationMinutes: number,
  criteria: StoppingPointCriteria = DEFAULT_CRITERIA
): Promise<StoppingPointAnalysis> {
  const reasons: string[] = [];
  const recommendations: string[] = [];
  let confidence = 0;

  const totalFiles = gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length;
  const totalCommits = gitStatus.commitsSinceLastStop;

  // Check minimum files changed
  if (totalFiles >= criteria.minFilesChanged) {
    confidence += 0.25;
    reasons.push(`Significant changes: ${totalFiles} files modified`);
  } else {
    recommendations.push(`Wait until at least ${criteria.minFilesChanged} files are changed`);
  }

  // Check commit accumulation
  if (totalCommits >= criteria.maxCommitsBeforeStop) {
    confidence += 0.35;
    reasons.push(`Commit threshold reached: ${totalCommits} commits`);
    recommendations.push("Create PR now - commit count is high");
  } else if (totalCommits >= criteria.maxCommitsBeforeStop / 2) {
    confidence += 0.15;
    reasons.push(`Moderate commit count: ${totalCommits} commits`);
  } else if (totalCommits > 0) {
    confidence += 0.08;
    reasons.push(`Some commits: ${totalCommits} commits`);
  }

  // Check duration
  if (durationMinutes >= criteria.maxDurationMinutes) {
    confidence += 0.35;
    reasons.push(`Time threshold reached: ${Math.round(durationMinutes)} minutes`);
    recommendations.push("Consider stopping - session duration is long");
  } else if (durationMinutes >= criteria.maxDurationMinutes / 2) {
    confidence += 0.1;
    reasons.push(`Approaching time threshold: ${Math.round(durationMinutes)} minutes`);
  }

  // Check test status
  if (criteria.requireTestsPassing) {
    if (testStatus === "passing") {
      confidence += 0.2;
      reasons.push("All tests passing");
    } else if (testStatus === "failing") {
      confidence -= 0.2;
      recommendations.push("Fix failing tests before creating PR");
    }
  }

  // Calculate complexity score based on files and changes
  const complexityScore = calculateComplexityScore(gitStatus);
  if (complexityScore >= criteria.maxComplexityScore) {
    confidence += 0.1;
    reasons.push(`High complexity: score ${complexityScore}`);
    recommendations.push("Consider breaking into smaller PRs");
  }

  // Task-specific logic
  if (task.classification === "refactoring" && totalFiles > 5) {
    confidence += 0.1;
    reasons.push("Refactoring work with multiple files - good stopping point");
  }

  // Determine if it's a good stopping point
  const isGoodStoppingPoint = confidence >= 0.6;

  return {
    isGoodStoppingPoint,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasons,
    recommendations,
    metrics: {
      filesChanged: totalFiles,
      commits: totalCommits,
      durationMinutes,
      testsPassing: testStatus === "passing",
      complexityScore,
      linesAdded: 0, // Would need git diff stats
      linesRemoved: 0,
    },
  };
}

/**
 * Calculate a complexity score based on git status
 */
function calculateComplexityScore(gitStatus: GitStatus): number {
  let score = 0;
  
  // Base score from file count - give more weight to unstaged changes
  score += gitStatus.staged.length * 2;
  score += gitStatus.unstaged.length * 4; // Higher weight for unstaged
  score += gitStatus.untracked.length * 1;
  
  // Penalty for having both staged and unstaged changes
  if (gitStatus.staged.length > 0 && gitStatus.unstaged.length > 0) {
    score += 15;
  }
  
  // Penalty for many untracked files
  if (gitStatus.untracked.length > 10) {
    score += 15;
  }
  
  // Penalty for many commits
  if (gitStatus.commitsSinceLastStop > 10) {
    score += 10;
  }
  
  return score;
}

/**
 * Get recommended next actions based on analysis
 */
export function getRecommendedActions(analysis: StoppingPointAnalysis): string[] {
  const actions: string[] = [];

  if (analysis.isGoodStoppingPoint) {
    actions.push("Create feature branch");
    actions.push("Organize and commit changes");
    actions.push("Open PR draft");
    
    if (analysis.metrics.complexityScore > 50) {
      actions.push("Consider splitting into multiple PRs");
    }
  } else {
    if (!analysis.metrics.testsPassing && analysis.metrics.testsPassing !== null) {
      actions.push("Fix failing tests");
    }
    
    if (analysis.metrics.filesChanged < 3) {
      actions.push("Continue working to reach minimum file threshold");
    }
    
    actions.push("Continue current task");
  }

  return actions;
}
