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
    const rows = this.context.db.query(`
      SELECT id, subject, description, classification, domain, priority
      FROM tasks
      WHERE status = 'pending'
        AND dependency_blocked = 0
        AND assigned_to IS NULL
        AND subject NOT LIKE 'Validate completion:%'
      ORDER BY 
        CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        created_at ASC
      LIMIT 20
    `).all() as Array<{
      id: string;
      subject: string;
      description: string;
      classification: string | null;
      domain: string | null;
      priority: string | null;
    }>;
    
    return rows.map(r => ({
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
    const rows = this.context.db.query(`
      SELECT id, title, description, priority, error_details
      FROM bugs
      WHERE status IN ('open', 'investigating')
        AND assignee_arm_id IS NULL
      ORDER BY 
        CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        created_at ASC
      LIMIT 10
    `).all() as Array<{
      id: string;
      title: string;
      description: string;
      priority: string;
      error_details: string | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      priority: r.priority,
      errorDetails: r.error_details || undefined,
    }));
  }

  /**
   * Get in-progress tasks
   */
  private async getInProgressTasks(): Promise<Array<{ id: string; subject: string }>> {
    const rows = this.context.db.query(`
      SELECT id, subject
      FROM tasks
      WHERE status IN ('in_progress', 'claimed')
      LIMIT 20
    `).all() as Array<{ id: string; subject: string }>;
    
    return rows;
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
    // Find tasks that:
    // 1. Are completed (or recently completed)
    // 2. Have status reports with issues_found, completed_with_issues, or needs_review
    // 3. Don't already have a verification task created for them
    const rows = this.context.db.query(`
      SELECT 
        t.id,
        t.subject,
        t.status,
        sr.id as status_report_id,
        sr.summary,
        sr.issues,
        sr.tests_status
      FROM tasks t
      INNER JOIN status_reports sr ON t.id = sr.task_id
      LEFT JOIN tasks vt ON vt.subject LIKE '%Verify%' || t.subject || '%'
      WHERE t.status = 'completed'
        AND sr.status IN ('issues_found', 'completed_with_issues', 'needs_review')
        AND vt.id IS NULL
      ORDER BY sr.created_at DESC
      LIMIT 5
    `).all() as Array<{
      id: string;
      subject: string;
      status: string;
      status_report_id: string;
      summary: string;
      issues: string;
      tests_status: string | null;
    }>;
    
    return rows.map(r => ({
      id: r.id,
      subject: r.subject,
      status: r.status,
      statusReportId: r.status_report_id,
      summary: r.summary,
      issues: JSON.parse(r.issues || "[]") as string[],
      testsStatus: r.tests_status || undefined,
    }));
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
        subject: `Verify & Polish: ${taskWithIssues.subject}`,
        description: `This is a verification task for: "${taskWithIssues.subject}"

The original task was completed but with issues that need attention.

## Original Completion Summary
${taskWithIssues.summary}
${issuesList}${testWarning}

## Original Task ID
${taskWithIssues.id}`,
        classification: "qa",  // Verification tasks are QA-type work
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
    // Find tasks that are marked as blocked or dependency_blocked
    // but whose dependencies are now completed
    const rows = this.context.db.query(`
      SELECT t.id, t.subject, t.description, t.classification, t.domain, t.priority
      FROM tasks t
      WHERE (t.status = 'blocked' OR t.dependency_blocked = 1)
        AND NOT EXISTS (
          SELECT 1 
          FROM task_dependencies td
          WHERE td.task_id = t.id
            AND NOT EXISTS (
              SELECT 1 FROM tasks dep 
              WHERE dep.id = td.depends_on_task_id 
                AND dep.status = 'completed'
            )
        )
      LIMIT 5
    `).all() as Array<{
      id: string;
      subject: string;
      description: string;
      classification: string | null;
      domain: string | null;
      priority: string | null;
    }>;
    
    return rows.map(r => ({
      id: r.id,
      subject: r.subject,
      description: r.description,
      classification: r.classification || undefined,
      domain: r.domain || undefined,
      priority: r.priority || undefined,
    }));
  }

  /**
   * Get the next task from the plan based on order and dependencies
   */
  private async getNextPlanTask(planId?: string): Promise<NextTaskResult | null> {
    // Get plan bullets that have tasks and check their status
    // For now, just return the next pending task with plan-like ordering
    const row = this.context.db.query(`
      SELECT id, subject, description, classification, domain, priority, plan_order
      FROM tasks
      WHERE status = 'pending' 
        AND dependency_blocked = 0
        AND assigned_to IS NULL
        AND plan_order IS NOT NULL
        AND subject NOT LIKE 'Validate completion:%'
      ORDER BY plan_order ASC
      LIMIT 1
    `).get() as {
      id: string;
      subject: string;
      description: string;
      classification: string | null;
      domain: string | null;
      priority: string | null;
      plan_order: number | null;
    } | null;
    
    if (!row) return null;
    
    return {
      task: {
        subject: row.subject,
        description: row.description,
        classification: row.classification || "development",
        domain: row.domain || undefined,
        priority: row.priority || "normal",
      },
      context: {
        planExcerpt: `Plan step ${row.plan_order}`,
        history: await this.getRecentHistory(3),
      },
      reasoning: `Next task from plan (step ${row.plan_order}).`,
    };
  }

  /**
   * Get recent completed task history for context
   */
  private async getRecentHistory(limit: number): Promise<string[]> {
    const rows = this.context.db.query(`
      SELECT subject, completed_at
      FROM tasks
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT ?
    `).all(limit) as Array<{ subject: string; completed_at: string }>;
    
    return rows.map(r => `✓ ${r.subject}`);
  }

  // NOTE: Domain-based arm matching is disabled for now
  // /**
  //  * Get domain preference for an arm
  //  */
  // private async getArmDomain(armId: string): Promise<string> {
  //   const row = this.context.db.query(`
  //     SELECT domain FROM arms WHERE id = ?
  //   `).get(armId) as { domain: string | null } | null;
  //   
  //   return row?.domain || "general";
  // }
}
