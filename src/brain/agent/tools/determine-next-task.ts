/**
 * Determine Next Task Tool
 * 
 * Implements progressive planning: determines the next task based on:
 * 1. Current plan document (bullets/steps to complete)
 * 2. Completed task history
 * 3. Status reports from arms (issues, blockers)
 * 4. Open discoveries
 * 
 * Decision logic:
 * - If completed AND no issues → skip
 * - If completed BUT has issues → assign "verify & polish" task
 * - If incomplete AND ready → assign development task
 * - If blocked → notify human, skip
 */

import { BrainTool } from "./base";
import type { ToolResult } from "./base";
import type { NextTaskResult, StatusReportItem } from "../types";
import {
	VALIDATION_TASK_SUBJECT_PREFIX,
	buildVerificationTaskSubject,
} from "../../task-subjects";

interface DetermineNextTaskInput {
  planId?: string;
  armId?: string;
  forceVerify?: boolean;  // Force verification even if no issues found
}

interface PlanBullet {
  taskId?: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  hasIssues: boolean;
  issueCount: number;
  dependencies: string[];
  dependenciesMet: boolean;
}

export class DetermineNextTaskTool extends BrainTool {
  name = "determineNextTask";
  description = `Determine the next task based on progressive planning. Analyzes the plan, completed tasks, status reports, and discoveries to find the most appropriate next task. Returns 'verify & polish' tasks for work with issues, or the next incomplete bullet point from the plan.`;
  
  inputSchema = {
    type: "object",
    properties: {
      planId: { type: "string", description: "Specific plan to evaluate (defaults to current phase plan)" },
      armId: { type: "string", description: "Arm ID requesting the task" },
      forceVerify: { type: "boolean", description: "Force verification task creation even if no issues", default: false },
    },
    required: [],
  };

  async execute(input: DetermineNextTaskInput): Promise<ToolResult<NextTaskResult>> {
    try {
      // Step 1: Get pending tasks and bugs
      const pendingTasks = await this.getPendingTasks();
      const pendingBugs = await this.getPendingBugs();
      const inProgressTasks = await this.getInProgressTasks();
      
      // Step 2: Check for tasks needing verification (completed with issues)
      const verificationNeeded = await this.getTasksNeedingVerification();
      
      if (verificationNeeded.length > 0) {
        const taskToVerify = verificationNeeded[0]!;
        return {
          success: true,
          data: this.createVerifyAndPolishTask(taskToVerify),
        };
      }
      
      // Step 3: Check for blocked tasks that might be unblocked
      const unblockedTasks = await this.checkForUnblockedTasks();
      if (unblockedTasks.length > 0) {
        const unblockedTask = unblockedTasks[0]!;
        return {
          success: true,
          data: {
            task: {
              subject: unblockedTask.subject,
              description: unblockedTask.description,
              classification: unblockedTask.classification || "development",
              domain: unblockedTask.domain,
              priority: unblockedTask.priority || "normal",
            },
            context: {
              planExcerpt: `Previously blocked task is now ready to proceed.`,
              history: [`Unblocked: dependencies now satisfied`],
            },
            reasoning: `Task "${unblockedTask.subject}" was blocked but dependencies are now complete.`,
          },
        };
      }
      
      // Step 4: Find next pending task from plan (respecting dependencies)
      const nextFromPlan = await this.getNextPlanTask(input.planId);
      
      if (nextFromPlan) {
        return {
          success: true,
          data: nextFromPlan,
        };
      }
      
      // NOTE: Domain-based task assignment is disabled for now
      // Step 5: If arm is specified, try to find domain-appropriate task
      // if (input.armId && pendingTasks.length > 0) {
      //   const armDomain = await this.getArmDomain(input.armId);
      //   const domainTask = pendingTasks.find(t => !t.domain || t.domain === armDomain);
      //   
      //   if (domainTask) {
      //     return {
      //       success: true,
      //       data: {
      //         task: {
      //           subject: domainTask.subject,
      //           description: domainTask.description,
      //           classification: domainTask.classification || "development",
      //           domain: domainTask.domain,
      //           priority: domainTask.priority || "normal",
      //         },
      //         context: {
      //           history: await this.getRecentHistory(3),
      //         },
      //         reasoning: `Assigning pending task matching arm domain (${armDomain}).`,
      //       },
      //     };
      //   }
      // }
      
      // Step 6: Distribute bugs and tasks equally
      // Return either the next pending bug or task based on equal distribution
      if (pendingBugs.length > 0 && (Math.random() < 0.5 || pendingTasks.length === 0)) {
        const bug = pendingBugs[0]!;
        return {
          success: true,
          data: {
            task: {
              subject: bug.title,
              description: bug.description,
              classification: "bug_fix",
              domain: undefined,
              priority: bug.priority,
            },
            context: {
              history: await this.getRecentHistory(3),
              ...bug.errorDetails ? { errorDetails: bug.errorDetails } : {},
            },
            reasoning: `Assigning pending bug for quick resolution. ${pendingTasks.length} tasks also available.`,
          },
        };
      } else if (pendingTasks.length > 0) {
        const task = pendingTasks[0]!;
        return {
          success: true,
          data: {
            task: {
              subject: task.subject,
              description: task.description,
              classification: task.classification || "development",
              domain: task.domain,
              priority: task.priority || "normal",
            },
            context: {
              history: await this.getRecentHistory(3),
            },
            reasoning: `Returning next pending task from queue.`,
          },
        };
      }
      
      // No tasks available
      return {
        success: true,
        data: {
          task: {
            subject: "No tasks available",
            description: "All plan items are either complete or blocked. Consider reviewing the plan or checking blocked tasks.",
            classification: "architect",
            priority: "low",
          },
          context: {
            planExcerpt: "Plan appears complete or all tasks are blocked.",
          },
          reasoning: "No pending tasks found. The plan may need review or there may be blockers to resolve.",
        },
      };
      
    } catch (error) {
      return { success: false, error: `Failed to determine next task: ${error}` };
    }
  }

  /**
   * Get pending tasks from database
   */
  private async getPendingTasks(): Promise<Array<{
    id: string;
    subject: string;
    description: string;
    classification?: string;
    domain?: string;
    priority?: string;
  }>> {
    const rows = this.context.db.listTasks({
      statuses: ["pending"],
      dependencyBlocked: false,
      unassignedOnly: true,
      excludeSubjectPrefix: VALIDATION_TASK_SUBJECT_PREFIX,
      sort: "priority_then_created_asc",
      limit: 20,
    });

    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      description: r.description,
      classification: r.classification || undefined,
      domain: r.domain || undefined,
      priority: r.priority || undefined,
    }));
  }

  /**
   * Get pending bugs from database
   */
  private async getPendingBugs(): Promise<Array<{
    id: string;
    title: string;
    description: string;
    priority: string;
    errorDetails?: string;
  }>> {
    const rows = this.context.db
      .listBugs({
        statuses: ["open", "investigating"],
        unassignedOnly: true,
        limit: 50,
      })
      .sort((a, b) => {
        const rank = (priority: string): number => {
          switch (priority) {
            case "critical":
              return 1;
            case "high":
              return 2;
            case "medium":
              return 3;
            default:
              return 4;
          }
        };
        const diff = rank(a.priority) - rank(b.priority);
        if (diff !== 0) {
          return diff;
        }
        return a.createdAt.localeCompare(b.createdAt);
      })
      .slice(0, 10);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      priority: r.priority,
      errorDetails: r.errorDetails || undefined,
    }));
  }

  /**
   * Get in-progress tasks
   */
  private async getInProgressTasks(): Promise<Array<{ id: string; subject: string }>> {
    return this.context.db
      .listTasks({
        statuses: ["in_progress", "claimed"],
        limit: 20,
      })
      .map((task) => ({ id: task.id, subject: task.subject }));
  }

  /**
   * Get tasks that completed but have status reports with issues
   * These need "verify & polish" follow-up tasks
   */
  private async getTasksNeedingVerification(): Promise<Array<{
    id: string;
    subject: string;
    status: string;
    statusReportId: string;
    summary: string;
    issues: string[];
    testsStatus?: string;
  }>> {
    const completedTasks = this.context.db.listTasks({
      statuses: ["completed"],
      limit: 200,
    });
    const reports = this.context.db.listStatusReports({
      limit: 500,
    });
    const verificationReports = reports.filter((report) =>
      ["issues_found", "completed_with_issues", "needs_review"].includes(
        report.status,
      ),
    );
    const taskMap = new Map(completedTasks.map((task) => [task.id, task]));
    const existingVerifyTasks = this.context.db.listTasks({
      includeSubject: "Verify",
      excludeStatuses: ["completed", "failed", "cancelled"],
      limit: 500,
    });

    const hasVerificationTask = (subject: string): boolean =>
      existingVerifyTasks.some((task) => task.subject.includes(subject));

    const candidates: Array<{
      id: string;
      subject: string;
      status: string;
      statusReportId: string;
      summary: string;
      issues: string[];
      testsStatus?: "passing" | "failing" | "not_run";
      reportCreatedAt: string;
    }> = [];

    for (const report of verificationReports) {
      const task = taskMap.get(report.taskId);
      if (!task) {
        continue;
      }
      if (hasVerificationTask(task.subject)) {
        continue;
      }

      candidates.push({
        id: task.id,
        subject: task.subject,
        status: task.status,
        statusReportId: report.id,
        summary: report.summary,
        issues: report.issues,
        testsStatus: report.testsStatus || undefined,
        reportCreatedAt: report.createdAt,
      });
    }

    return candidates
      .sort((a, b) => b.reportCreatedAt.localeCompare(a.reportCreatedAt))
      .map(({ reportCreatedAt: _reportCreatedAt, ...rest }) => rest)
      .slice(0, 5);
  }

  /**
   * Create a verify & polish task for a task with issues
   */
  private createVerifyAndPolishTask(taskWithIssues: {
    id: string;
    subject: string;
    summary: string;
    issues: string[];
    testsStatus?: string;
  }): NextTaskResult {
    const issuesList = taskWithIssues.issues.length > 0
      ? `\n\n## Issues to Address\n${taskWithIssues.issues.map(i => `- ${i}`).join("\n")}`
      : "";
    
    const testWarning = taskWithIssues.testsStatus === "failing"
      ? "\n\n## ⚠️ Tests are failing - this should be addressed first"
      : "";

    return {
      task: {
        subject: buildVerificationTaskSubject(taskWithIssues.subject),
        description: `This is a verification task for: "${taskWithIssues.subject}"

The original task was completed but with issues that need attention.

## Original Completion Summary
${taskWithIssues.summary}
${issuesList}${testWarning}

## Original Task ID
${taskWithIssues.id}`,
        classification: "qa",
        priority: "high",
      },
      context: {
        planExcerpt: `Follow-up verification for task ${taskWithIssues.id}`,
        discoveries: taskWithIssues.issues,
        history: [`Original task: ${taskWithIssues.subject}`],
      },
      reasoning: `Task "${taskWithIssues.subject}" completed with ${taskWithIssues.issues.length} issue(s). Creating verification task.`,
    };
  }

  /**
   * Check for blocked tasks whose dependencies are now satisfied
   */
  private async checkForUnblockedTasks(): Promise<Array<{
    id: string;
    subject: string;
    description: string;
    classification?: string;
    domain?: string;
    priority?: string;
  }>> {
    const blockedTasks = this.context.db.listTasks({
      limit: 500,
    }).filter((task) => task.status === "blocked" || task.dependencyBlocked);

    const result: Array<{
      id: string;
      subject: string;
      description: string;
      classification?: string;
      domain?: string;
      priority?: string;
    }> = [];

    for (const task of blockedTasks) {
      const deps = this.context.db.listTaskDependencies(task.id);
      const hasUnmetDependency = deps.some((dep) => {
        const dependencyTask = this.context.db.getTask(dep.dependsOnTaskId);
        return !dependencyTask || dependencyTask.status !== "completed";
      });

      if (!hasUnmetDependency) {
        result.push({
          id: task.id,
          subject: task.subject,
          description: task.description,
          classification: task.classification || undefined,
          domain: task.domain || undefined,
          priority: task.priority || undefined,
        });
      }
    }

    return result.slice(0, 5);
  }

  /**
   * Get the next task from the plan based on order and dependencies
   */
  private async getNextPlanTask(planId?: string): Promise<NextTaskResult | null> {
    void planId;

    const row = this.context.db
      .listTasks({
        statuses: ["pending"],
        dependencyBlocked: false,
        unassignedOnly: true,
        excludeSubjectPrefix: VALIDATION_TASK_SUBJECT_PREFIX,
        sort: "sort_order_asc",
        limit: 1,
      })[0];

    if (!row) {
      return null;
    }
    
    return {
      task: {
        subject: row.subject,
        description: row.description,
        classification: row.classification || "development",
        domain: row.domain || undefined,
        priority: row.priority || "normal",
      },
      context: {
        planExcerpt: `Plan step ${row.sortOrder ?? "?"}`,
        history: await this.getRecentHistory(3),
      },
      reasoning: `Next task from plan (step ${row.sortOrder ?? "?"}).`,
    };
  }

  /**
   * Get recent completed task history for context
   */
  private async getRecentHistory(limit: number): Promise<string[]> {
    return this.context.db
      .listTasks({
        statuses: ["completed"],
        sort: "completed_desc",
        limit,
      })
      .map((row) => `✓ ${row.subject}`);
  }

  // NOTE: Domain-based arm matching is disabled for now.
}
