/**
 * Prompt Generator for CLI Testing
 * 
 * Generates plain-text outputs for brain task determination and context bundles.
 * These can be copied and pasted into interactive agent text areas.
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { readFile } from "fs/promises";
import fg from "fast-glob";
import type { Discovery, Task } from "../types";

export interface PromptContext {
  projectRoot: string;
  octopaiDir: string;
  db: Database;
}

export interface TaskDeterminationResult {
  task: {
    id?: string;
    subject: string;
    description: string;
    classification: string;
    priority: string;
    domain?: string;
  } | null;
  reasoning: string;
  planExcerpt: string;
  completedTasks: string[];
  openDiscoveries: string[];
}

export interface ContextBundleResult {
  task: {
    subject: string;
    description: string;
    classification: string;
    priority: string;
  };
  context: {
    discoveries: string;
    planExcerpt: string;
    taskHistory: string;
    instructions: string;
  };
  fullOutput: string;
}

/**
 * Generate task determination output showing what the brain would decide
 */
export async function generateTaskDetermination(ctx: PromptContext): Promise<TaskDeterminationResult> {
  const { db, projectRoot } = ctx;

  // 1. Read current plan
  const plan = await readCurrentPlan(projectRoot);
  
  // 2. Get completed tasks from database
  const completedTasks = await getCompletedTasks(db);
  
  // 3. Get open discoveries
  const discoveries = await getOpenDiscoveries(db);
  
  // 4. Get pending tasks from both database and file system
  const dbPendingTasks = await getPendingTasks(db);
  const filePendingTasks = await getTasksFromFiles(projectRoot);
  
  // 5. Merge tasks - prefer file tasks, then db tasks
  const allTasks: Task[] = [
    ...filePendingTasks.map(t => ({
      id: t.id,
      subject: t.subject,
      description: t.description,
      status: t.status,
      priority: t.priority,
      domain: t.domain || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    ...dbPendingTasks,
  ];
  
  // 6. Determine next task based on progressive planning
  const result = determineNextTask(plan, completedTasks, discoveries, allTasks);

  return {
    task: result.task,
    reasoning: result.reasoning,
    planExcerpt: plan.content,
    completedTasks: completedTasks.map(t => `- ${t.subject} (${t.status})`),
    openDiscoveries: discoveries.map(d => `- [${d.severity || "info"}] ${d.title}: ${d.details}`),
  };
}

/**
 * Generate full context bundle for a task
 */
export async function generateContextBundle(ctx: PromptContext, taskSubject: string): Promise<ContextBundleResult | null> {
  const { db, projectRoot } = ctx;

  // 1. Get the task
  const task = await getTaskBySubject(db, taskSubject);
  if (!task) {
    return null;
  }

  // 2. Get discoveries relevant to the task
  const discoveries = await getOpenDiscoveries(db);
  
  // 3. Get completed tasks
  const completedTasks = await getCompletedTasks(db);
  
  // 4. Read plan
  const plan = await readCurrentPlan(projectRoot);

  // 5. Generate instructions based on task classification
  const instructions = generateInstructions(task);

  const fullOutput = buildContextBundle(task, {
    discoveries,
    completedTasks,
    planExcerpt: plan.content,
    instructions,
  });

  return {
    task: {
      subject: task.subject,
      description: task.description,
      classification: task.domain || "development",
      priority: task.priority,
    },
    context: {
      discoveries: discoveries.map(d => 
        `## Discovery: ${d.title}
Kind: ${d.kind}
Severity: ${d.severity || "info"}
Details: ${d.details}
${d.file ? `File: ${d.file}` : ""}`
      ).join("\n\n"),
      planExcerpt: plan.content,
      taskHistory: completedTasks.slice(0, 5).map(t => 
        `- ${t.subject} (completed: ${t.completedAt || "unknown"})`
      ).join("\n"),
      instructions,
    },
    fullOutput,
  };
}

// ============================================
// Helper Functions
// ============================================

async function readCurrentPlan(projectRoot: string): Promise<{ content: string; goals: string[]; bullets: string[] }> {
  const plansDir = join(projectRoot, ".project", "plans");
  let planFiles: string[] = [];
  try {
    planFiles = await fg("*.md", { cwd: plansDir });
  } catch {
    // Directory might not exist
  }

  let content = "";
  const goals: string[] = [];
  const bullets: string[] = [];

  if (planFiles.length > 0) {
    planFiles.sort();
    const latestPlan = planFiles[planFiles.length - 1];
    if (latestPlan) {
      content = await readFile(join(plansDir, latestPlan), "utf-8");
    }
  } else {
    const mainPlanPath = join(projectRoot, ".project", "plan.md");
    try {
      content = await readFile(mainPlanPath, "utf-8");
    } catch {
      content = "# No plan found\n\nNo plan document exists yet.";
    }
  }

  const lines = content.split("\n");
  let inGoals = false;
  let inBullets = false;

  for (const line of lines) {
    if (line.startsWith("## Goal")) {
      inGoals = true;
      inBullets = false;
      continue;
    }
    if (line.startsWith("## Approach") || line.startsWith("## Implementation")) {
      inGoals = false;
      inBullets = true;
      continue;
    }
    if (line.startsWith("## ") && !inGoals && !inBullets) {
      inGoals = false;
      inBullets = false;
    }

    if (inGoals && line.startsWith("- ")) {
      goals.push(line.slice(2).trim());
    }
    if (inBullets && (line.startsWith("- ") || line.match(/^\d+\./))) {
      bullets.push(line.replace(/^-\s*|^\d+\.\s*/, "").trim());
    }
  }

  return { content, goals, bullets };
}

async function getCompletedTasks(db: Database): Promise<Array<{ subject: string; status: string; completedAt?: string }>> {
  try {
    const results = db.query(`
      SELECT subject, status, completed_at
      FROM tasks
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 10
    `).all() as Array<{ subject: string; status: string; completed_at: string | null }>;

    return results.map(r => ({
      subject: r.subject,
      status: r.status,
      completedAt: r.completed_at || undefined,
    }));
  } catch {
    return [];
  }
}

async function getPendingTasks(db: Database): Promise<Task[]> {
  try {
    const results = db.query(`
      SELECT id, subject, description, status, priority, domain
      FROM tasks
      WHERE status = 'pending'
      ORDER BY 
        CASE priority 
          WHEN 'critical' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'normal' THEN 3 
          WHEN 'low' THEN 4 
        END,
        created_at ASC
      LIMIT 5
    `).all() as Array<{
      id: string;
      subject: string;
      description: string;
      status: string;
      priority: string;
      domain: string | null;
    }>;

    return results.map(r => ({
      id: r.id,
      subject: r.subject,
      description: r.description,
      status: r.status as Task["status"],
      priority: r.priority as Task["priority"],
      domain: r.domain || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  } catch {
    return [];
  }
}

async function getTasksFromFiles(projectRoot: string): Promise<Array<{ id: string; subject: string; description: string; status: Task["status"]; priority: Task["priority"]; domain?: string }>> {
  const tasks: Array<{ id: string; subject: string; description: string; status: Task["status"]; priority: Task["priority"]; domain?: string }> = [];
  
  const currentPath = join(projectRoot, ".project", "tasks", "current.md");
  try {
    const content = await readFile(currentPath, "utf-8");
    const lines = content.split("\n");
    let currentTask: { id: string; subject: string; description: string; priority: Task["priority"] } | null = null;
    let inReady = false;
    let inProgress = false;

    for (const line of lines) {
      if (line.startsWith("## Ready to Start")) {
        inReady = true;
        inProgress = false;
        continue;
      }
      if (line.startsWith("## In Progress")) {
        inReady = false;
        inProgress = true;
        continue;
      }
      if (line.startsWith("## ")) {
        inReady = false;
        inProgress = false;
        continue;
      }

      const taskMatch = line.match(/^### \[(TASK-\d+)\] (.+)/);
      if (taskMatch && inReady) {
        if (currentTask) {
          tasks.push({
            id: currentTask.id,
            subject: currentTask.subject,
            description: currentTask.description,
            status: "pending",
            priority: currentTask.priority,
          });
        }
        const taskId = taskMatch[1]!;
        const taskSubject = taskMatch[2]!;
        currentTask = {
          id: taskId,
          subject: taskSubject,
          description: "",
          priority: "high",
        };
        continue;
      }

      const priorityMatch = line.match(/- \*\*Priority\*\*: (\w+)/);
      if (priorityMatch && currentTask) {
        const priority = priorityMatch[1]!;
        currentTask.priority = priority.toLowerCase() as Task["priority"];
        continue;
      }

      if (line.startsWith("**Description**:") && currentTask) {
        currentTask.description = line.replace("**Description**:", "").trim();
        continue;
      }
    }

    if (currentTask) {
      tasks.push({
        id: currentTask.id,
        subject: currentTask.subject,
        description: currentTask.description,
        status: "pending",
        priority: currentTask.priority,
      });
    }
  } catch {
    // File might not exist or be parseable
  }

  return tasks;
}

async function getOpenDiscoveries(db: Database): Promise<Discovery[]> {
  try {
    const results = db.query(`
      SELECT kind, title, details, file_path, line_number, severity
      FROM discoveries
      WHERE status = 'open'
      ORDER BY 
        CASE severity 
          WHEN 'error' THEN 1 
          WHEN 'warning' THEN 2 
          WHEN 'info' THEN 3 
        END,
        created_at DESC
      LIMIT 20
    `).all() as Array<{
      kind: string;
      title: string;
      details: string;
      file_path: string | null;
      line_number: number | null;
      severity: string;
    }>;

    return results.map(r => ({
      kind: r.kind as Discovery["kind"],
      title: r.title,
      details: r.details,
      file: r.file_path || undefined,
      line: r.line_number || undefined,
      severity: (r.severity || "info") as Discovery["severity"],
    }));
  } catch {
    return [];
  }
}

async function getTaskBySubject(db: Database, subject: string): Promise<Task | null> {
  try {
    const result = db.query(`
      SELECT id, subject, description, status, priority, domain, metadata
      FROM tasks
      WHERE subject LIKE ? OR id = ?
      LIMIT 1
    `).get(`%${subject}%`, subject) as {
      id: string;
      subject: string;
      description: string;
      status: string;
      priority: string;
      domain: string | null;
      metadata: string;
    } | undefined;

    if (!result) return null;

    return {
      id: result.id,
      subject: result.subject,
      description: result.description,
      status: result.status as Task["status"],
      priority: result.priority as Task["priority"],
      domain: result.domain || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      context: result.metadata ? { notes: result.metadata } : undefined,
    };
  } catch {
    return null;
  }
}

interface TaskDeterminationResultInternal {
  task: {
    id?: string;
    subject: string;
    description: string;
    classification: string;
    priority: string;
    domain?: string;
  } | null;
  reasoning: string;
}

function determineNextTask(
  plan: { goals: string[]; bullets: string[] },
  completedTasks: Array<{ subject: string }>,
  discoveries: Discovery[],
  pendingTasks: Task[]
): TaskDeterminationResultInternal {
  if (pendingTasks.length > 0) {
    const task = pendingTasks[0]!;
    return {
      task: {
        id: task.id,
        subject: task.subject,
        description: task.description,
        classification: task.domain || "development",
        priority: task.priority,
        domain: task.domain,
      },
      reasoning: `Found ${pendingTasks.length} pending task(s). Selecting highest priority: ${task.priority} - ${task.subject}`,
    };
  }

  if (discoveries.length > 0) {
    const hasError = discoveries.some(d => d.severity === "error");
    return {
      task: {
        subject: "Verify & Address Open Discoveries",
        description: `Review and address ${discoveries.length} open discovery(ies):

${discoveries.map(d => `- ${d.title} (${d.severity || "info"})`).join("\n")}

For each discovery:
1. Investigate the issue
2. Fix if code-related
3. Document findings
4. Update discovery status`,
        classification: "verify",
        priority: hasError ? "high" : "normal",
      },
      reasoning: `Found ${discoveries.length} open discovery(ies). Creating verify task to address them.`,
    };
  }

  if (plan.bullets.length > 0 && completedTasks.length >= plan.bullets.length) {
    return {
      task: {
        subject: "Review Phase Completion",
        description: "All planned work appears complete. Review and decide on next steps:\n\n1. Review completed work against plan\n2. Identify any gaps\n3. Create plan for next phase",
        classification: "architect",
        priority: "normal",
      },
      reasoning: "Plan appears complete. Suggesting architect review.",
    };
  }

  // Check if this is a fresh/empty project with no pending work
  const hasPendingPlanWork = plan.bullets && plan.bullets.length > 0;
  
  if (!hasPendingPlanWork && pendingTasks.length === 0) {
    // Fresh/empty project - offer specific options
    return {
      task: {
        subject: "New Project Setup - What would you like help with?",
        description: `This project has no pending tasks or planned work. What would you like me to help with?

## Options

### 1. Code Review & Refactoring
I'll explore the codebase and identify:
- Dead code or unused files
- Code that could be simplified
- Inconsistent patterns or style issues
- Performance improvement opportunities
- Test coverage gaps

### 2. Documentation & README Updates
I'll analyze the codebase and update:
- README.md with accurate project description
- Documentation for existing features
- API documentation if applicable
- Architecture decision records
- "Future work" notes for unimplemented features

### 3. Create a Project Plan
I'll work with you to define:
- Goals for the project
- Phased implementation approach
- Task breakdown for future work

## How to Proceed

Reply with one of:
- "do code review" or "refactor" → I'll start exploring the codebase
- "update documentation" or "write docs" → I'll document what exists
- "help me plan" or "create plan" → We'll define work together
- Your own description of what you'd like help with

## Note

I won't start any actual implementation work without your explicit direction. I can explore, document, and plan - but I need your approval before making code changes.`,
        classification: "architect",
        priority: "normal",
      },
      reasoning: "Fresh/empty project detected. Offering options: code review, documentation, or planning.",
    };
  }

  return {
    task: {
      subject: "Determine Next Work",
      description: "The system has completed all known tasks. Please provide new work:\n\n1. What's the next feature to implement?\n2. What should be tested or documented?\n3. Any refactoring needed?",
      classification: "architect",
      priority: "normal",
    },
    reasoning: "No pending tasks, no open discoveries, plan status unclear. Asking for human input.",
  };
}

function generateInstructions(task: Task): string {
  let baseInstructions = `## Your Task: ${task.subject}

${task.description}

## Important Context

- You are an AI agent executing a specific task
- Report discoveries as you find them using report_discovery
- Complete the task when done using complete_task
- If you need clarification, ask for it

## Process

1. Read and understand the task above
2. Explore the codebase as needed
3. Make changes to implement or fix the issue
4. Report any discoveries (bugs, patterns, issues)
5. Complete the task with a summary`;

  const domain = task.domain?.toLowerCase() || "";
  const subject = task.subject.toLowerCase();

  if (domain === "docs" || subject.includes("doc")) {
    return baseInstructions + `

## Documentation-Specific

- Focus on feature docs, API docs, and capabilities docs
- Do NOT update conceptual or architectural docs
- Match docs to actual code implementation
- Add "Future Work" notes for planned but unimplemented features`;
  }

  if (domain === "testing" || subject.includes("test")) {
    return baseInstructions + `

## Testing-Specific

- Write tests that verify the implementation
- Consider edge cases
- Ensure tests are maintainable
- Run existing tests to verify nothing is broken`;
  }

  return baseInstructions;
}

function buildContextBundle(
  task: Task,
  context: {
    discoveries: Discovery[];
    completedTasks: Array<{ subject: string; completedAt?: string }>;
    planExcerpt: string;
    instructions: string;
  }
): string {
  return `=== OCTOPAI TASK ASSIGNMENT ===

## TASK INFORMATION
Subject: ${task.subject}
Priority: ${task.priority}
Classification: ${task.domain || "development"}
ID: ${task.id}

## TASK DESCRIPTION
${task.description}

=== CONTEXT BUNDLE ===

## INSTRUCTIONS
${context.instructions}

## OPEN DISCOVERIES
${context.discoveries.length > 0 ? context.discoveries.map(d => 
`- [${(d.severity || "info").toUpperCase()}] ${d.title}
  Kind: ${d.kind}
  Details: ${d.details}
  ${d.file ? `File: ${d.file}${d.line ? `:${d.line}` : ""}` : ""}`
).join("\n") : "No open discoveries."}

## COMPLETED TASKS (Recent)
${context.completedTasks.length > 0 ? context.completedTasks.slice(0, 5).map(t => 
`- ${t.subject}${t.completedAt ? ` (${t.completedAt.split("T")[0]})` : ""}`
).join("\n") : "No completed tasks recorded."}

## PLAN EXCERPT
${context.planExcerpt.slice(0, 2000)}

=== END CONTEXT BUNDLE ===

When you complete the task, use the complete_task MCP tool with:
- task_id: "${task.id}"
- summary: What you accomplished
- artifacts: Any files changed or created

Good luck!`;
}

/**
 * Format task determination as plain text for CLI output
 */
export function formatTaskDetermination(result: TaskDeterminationResult): string {
  let output = `=== OCTOPAI TASK DETERMINATION ===
Generated: ${new Date().toISOString()}

## REASONING
${result.reasoning}

`;

  if (result.task) {
    output += `## RECOMMENDED TASK
ID: ${result.task.id || "(synthetic - not in database)"}
Subject: ${result.task.subject}
Classification: ${result.task.classification}
Priority: ${result.task.priority}
${result.task.domain ? `Domain: ${result.task.domain}` : ""}

Description:
${result.task.description}
`;
  } else {
    output += `## NO TASK DETERMINED
Unable to determine next task. See reasoning above.
`;
  }

  output += `

## PLAN STATUS
${result.planExcerpt.slice(0, 1000)}

## COMPLETED TASKS (${result.completedTasks.length})
${result.completedTasks.length > 0 ? result.completedTasks.join("\n") : "None recorded"}

## OPEN DISCOVERIES (${result.openDiscoveries.length})
${result.openDiscoveries.length > 0 ? result.openDiscoveries.join("\n") : "None recorded"}

=== END TASK DETERMINATION ===
`;
  return output;
}

/**
 * Format context bundle as plain text for CLI output
 */
export function formatContextBundle(result: ContextBundleResult): string {
  return result.fullOutput;
}
