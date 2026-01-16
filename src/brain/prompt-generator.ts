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
  const now = new Date().toISOString();

  const plan = await readCurrentPlan(projectRoot);
  const planExcerpt = plan.currentPhase || plan.content;
  const phaseInfo = buildPhaseInfo(plan.currentPhase);
  const snapshot = await buildStatusSnapshot(db);

  const finalize = (step: DeterminationStepResult): TaskDeterminationResult => ({
    task: step.task,
    reasoning: step.reasoning,
    planExcerpt,
    completedTasks: snapshot.completed,
    openDiscoveries: snapshot.discoveries,
  });

  const activeTask = pickExistingActiveTask(db, phaseInfo.label);
  if (activeTask) {
    return finalize(activeTask);
  }

  const unblockedTask = tryUnblockDependencies(db, phaseInfo.label);
  if (unblockedTask) {
    return finalize(unblockedTask);
  }

  const newPlanTask = createPlanTaskDeliverable(db, plan, phaseInfo.label, now);
  if (newPlanTask) {
    return finalize(newPlanTask);
  }

  return finalize(buildNoTaskResult(phaseInfo));
}

interface DeterminationStepResult {
  task: TaskDeterminationResult["task"];
  reasoning: string;
}

interface PhaseInfo {
  label: string;
  header: string;
}

interface StatusSnapshot {
  completed: string[];
  discoveries: string[];
}

function buildPhaseInfo(phaseSection: string): PhaseInfo {
  const headerLine = phaseSection.split("\n")[0]?.trim() ?? "";
  const match = headerLine.match(/^## (Phase \d+(?:\.\d+)?)/);

  if (match) {
    return { label: match[1]!, header: headerLine };
  }

  const cleanedHeader = headerLine.replace(/^##\s*/, "").trim();
  const fallback = cleanedHeader || "Unknown Phase";

  return {
    label: fallback,
    header: headerLine || fallback,
  };
}

function pickExistingActiveTask(db: Database, phaseLabel: string): DeterminationStepResult | null {
  const phaseValue = phaseLabel || "";
  const activeTasks = db.query(`
    SELECT id, subject, description, status, priority, domain, assigned_arms, consensus_status
    FROM tasks
    WHERE status IN ('pending', 'claimed', 'in_progress', 'verification_pending')
      AND (consensus_status IS NULL OR consensus_status != 'reached')
      AND (phase = ? OR phase = '' OR phase IS NULL)
    ORDER BY created_at ASC
  `).all(phaseValue) as Array<{
    id: string;
    subject: string;
    description: string;
    status: string;
    priority: string;
    domain: string | null;
    assigned_arms: string | null;
    consensus_status: string | null;
  }>;

  if (activeTasks.length === 0) {
    return null;
  }

  const task = activeTasks[0]!;
  const assignedArms = parseArmsFromJson(task.assigned_arms || "[]");

  return {
    task: {
      id: task.id,
      subject: task.subject,
      description: task.description,
      classification: task.domain || "development",
      priority: task.priority,
      domain: task.domain || undefined,
    },
    reasoning: `Active task with ${assignedArms.length} arm(s) assigned${task.consensus_status ? `, consensus: ${task.consensus_status}` : ""}`,
  };
}

function tryUnblockDependencies(db: Database, phaseLabel: string): DeterminationStepResult | null {
  const phaseValue = phaseLabel || "";
  const blockedTasks = db.query(`
    SELECT id, subject, description, priority, domain
    FROM tasks
    WHERE status = 'pending'
      AND dependency_blocked = 1
      AND (phase = ? OR phase = '' OR phase IS NULL)
    ORDER BY created_at ASC
  `).all(phaseValue) as Array<{
    id: string;
    subject: string;
    description: string;
    priority: string;
    domain: string | null;
  }>;

  for (const blockedTask of blockedTasks) {
    const dependencies = db.query(`
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
    `).all(blockedTask.id) as Array<{ depends_on_task_id: string }>;

    const unmetDeps: string[] = [];
    for (const dep of dependencies) {
      const depTask = db.query(`
        SELECT status, consensus_status FROM tasks WHERE id = ?
      `).get(dep.depends_on_task_id) as { status: string; consensus_status: string | null } | undefined;

      if (!depTask || (depTask.status !== 'completed' && depTask.consensus_status !== 'reached')) {
        unmetDeps.push(dep.depends_on_task_id);
      }
    }

    if (unmetDeps.length === 0) {
      db.run(`UPDATE tasks SET dependency_blocked = 0 WHERE id = ?`, [blockedTask.id]);

      return {
        task: {
          id: blockedTask.id,
          subject: blockedTask.subject,
          description: blockedTask.description,
          classification: blockedTask.domain || "development",
          priority: blockedTask.priority,
          domain: blockedTask.domain || undefined,
        },
        reasoning: `Dependencies resolved. Unblocked: ${blockedTask.priority} - ${blockedTask.subject}`,
      };
    }
  }

  return null;
}

function createPlanTaskDeliverable(
  db: Database,
  plan: { currentPhase: string; bullets: string[] },
  phaseLabel: string,
  now: string
): DeterminationStepResult | null {
  const nextTask = createNextTaskFromPlan(db, plan, phaseLabel || "Unknown Phase", now);
  if (!nextTask) {
    return null;
  }

  const dependencies = detectDependencies(db, nextTask.id, nextTask.subject);
  const sourceRef = plan.currentPhase.split('\n')[0]?.substring(0, 100) || phaseLabel || "plan";

  db.run(`
    INSERT INTO tasks (id, subject, description, status, priority, domain, phase, source_type, source_ref, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, 'plan', ?, ?, ?)
  `, [
    nextTask.id,
    nextTask.subject,
    nextTask.description,
    nextTask.priority,
    nextTask.domain || null,
    phaseLabel || "Unknown Phase",
    sourceRef,
    now,
    now,
  ]);

  for (const dep of dependencies) {
    db.run(`
      INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, dependency_type, auto_detected, reason)
      VALUES (?, ?, 'finish_to_start', 1, ?)
    `, [nextTask.id, dep.taskId, dep.reason]);
  }

  const depTaskIds = dependencies.map(d => d.taskId);
  if (depTaskIds.length > 0) {
    const placeholders = depTaskIds.map(() => '?').join(',');
    const incompleteDeps = db.query(`
      SELECT id FROM tasks WHERE id IN (${placeholders})
        AND status != 'completed'
        AND (consensus_status IS NULL OR consensus_status != 'reached')
    `).all(...depTaskIds) as Array<{ id: string }>;

    if (incompleteDeps.length > 0) {
      db.run(`UPDATE tasks SET dependency_blocked = 1 WHERE id = ?`, [nextTask.id]);
    }
  }

  return {
    task: {
      id: nextTask.id,
      subject: nextTask.subject,
      description: nextTask.description,
      classification: nextTask.domain || "development",
      priority: nextTask.priority,
      domain: nextTask.domain,
    },
    reasoning: `Created new task from ${phaseLabel || "plan"}${dependencies.length > 0 ? ` (${dependencies.length} dependency${dependencies.length > 1 ? "s" : ""} detected)` : ""}: ${nextTask.priority} - ${nextTask.subject}`,
  };
}

function buildNoTaskResult(phaseInfo: PhaseInfo): DeterminationStepResult {
  const label = phaseInfo.label || "current phase";
  return {
    task: {
      subject: "Determine Next Work",
      description: `The current phase (${label}) has no remaining deliverables marked as incomplete.

Review the plan and decide what to work on next:
1. Add new items to the current phase in plan.md
2. Move to a new phase
3. Request specific work via email`,
      classification: "architect",
      priority: "normal",
    },
    reasoning: `No deliverables found in ${label}. Plan may be complete or needs updating.`,
  };
}

async function buildStatusSnapshot(db: Database): Promise<StatusSnapshot> {
  const [completedTasks, discoveries] = await Promise.all([
    getCompletedTasks(db),
    getOpenDiscoveries(db),
  ]);

  return {
    completed: completedTasks.map(t => `- ${t.subject}${t.completedAt ? ` (${t.completedAt.split("T")[0]})` : ""}`),
    discoveries: discoveries.map(d => `- [${(d.severity || "info").toUpperCase()}] ${d.title}`),
  };
}

interface DetectedDependency {
  taskId: string;
  reason: string;
}

function detectDependencies(
  db: Database,
  taskId: string,
  taskSubject: string
): DetectedDependency[] {
  const dependencies: DetectedDependency[] = [];
  const subjectLower = taskSubject.toLowerCase();

  // Common dependency patterns
  const dependencyRules: Array<{
    keywords: string[];
    dependsOnKeywords: string[];
    reason: string;
  }> = [
    {
      keywords: ['api', 'server', 'endpoint'],
      dependsOnKeywords: ['database', 'schema'],
      reason: 'API typically requires database schema',
    },
    {
      keywords: ['websocket', 'realtime', 'real-time'],
      dependsOnKeywords: ['api', 'server'],
      reason: 'WebSocket builds on API server',
    },
    {
      keywords: ['ui', 'dashboard', 'frontend', 'react'],
      dependsOnKeywords: ['api', 'server', 'endpoint'],
      reason: 'UI typically requires API endpoints',
    },
    {
      keywords: ['test', 'qa', 'verify'],
      dependsOnKeywords: ['implementation', 'code', 'feature'],
      reason: 'Tests require existing implementation',
    },
    {
      keywords: ['documentation', 'docs', 'readme'],
      dependsOnKeywords: ['implementation', 'feature', 'api'],
      reason: 'Documentation requires implementation',
    },
    {
      keywords: ['migration', 'schema'],
      dependsOnKeywords: ['database'],
      reason: 'Migration requires database',
    },
  ];

  // Find existing tasks that could be dependencies
  const existingTasks = db.query(`
    SELECT id, subject, status, consensus_status FROM tasks
    WHERE status IN ('pending', 'claimed', 'in_progress', 'verification_pending')
    AND id != ?
  `).all(taskId) as Array<{ id: string; subject: string; status: string; consensus_status: string | null }>;

  for (const rule of dependencyRules) {
    // Check if current task matches keywords
    const taskMatches = rule.keywords.some(k => subjectLower.includes(k));
    if (!taskMatches) continue;

    // Find existing tasks that match dependsOnKeywords
    for (const existingTask of existingTasks) {
      const existingLower = existingTask.subject.toLowerCase();
      const isBlocked = existingTask.status !== 'completed' && existingTask.consensus_status !== 'reached';
      
      if (isBlocked && rule.dependsOnKeywords.some(k => existingLower.includes(k))) {
        // Check if we already have this dependency
        const existing = dependencies.find(d => d.taskId === existingTask.id);
        if (!existing) {
          dependencies.push({
            taskId: existingTask.id,
            reason: rule.reason,
          });
        }
      }
    }
  }

  return dependencies;
}

function parseArmsFromJson(json: string): string[] {
  try {
    return JSON.parse(json || '[]');
  } catch {
    return [];
  }
}

interface PlanTask {
  id: string;
  subject: string;
  description: string;
  priority: Task["priority"];
  domain?: string;
}

function createNextTaskFromPlan(
  db: Database,
  plan: { currentPhase: string; bullets: string[] },
  phaseName: string,
  now: string
): PlanTask | null {
  // Get already-created tasks for this phase
  const existingTasks = db.query(`
    SELECT subject FROM tasks WHERE phase = ?
  `).all(phaseName) as Array<{ subject: string }>;

  const existingSubjects = new Set(existingTasks.map(t => t.subject.toLowerCase()));

  // Find the first incomplete deliverable from the current phase
  const phaseLines = plan.currentPhase.split('\n');
  
  for (let i = 0; i < phaseLines.length; i++) {
    const line = phaseLines[i]!;
    
    // Look for unchecked deliverables: "- [ ]" or "- [x]" patterns
    const deliverableMatch = line.match(/^- \[ \] (.+)/);
    if (deliverableMatch) {
      const subject = deliverableMatch[1]!.trim();
      
      // Skip if already created
      if (existingSubjects.has(subject.toLowerCase())) {
        continue;
      }

      // Generate a task ID based on phase and subject
      const taskId = generateTaskId(phaseName, subject);
      
      // Look for associated acceptance criteria
      let description = `Implement: ${subject}\n\n`;
      
      // Look for acceptance criteria below (lines starting with "- [ ]")
      const acceptanceCriteria: string[] = [];
      for (let j = i + 1; j < phaseLines.length; j++) {
        const nextLine = phaseLines[j]!;
        if (nextLine.startsWith('- [ ]')) {
          acceptanceCriteria.push(nextLine.replace('- [ ]', '•').trim());
        } else if (nextLine.startsWith('- [')) {
          // Skip checked items
          continue;
        } else if (nextLine.startsWith('## ') || nextLine.startsWith('### ') || nextLine.trim() === '') {
          // Stop at next section header or empty line
          break;
        }
      }
      
      if (acceptanceCriteria.length > 0) {
        description += `**Acceptance Criteria**:\n${acceptanceCriteria.join('\n')}`;
      } else {
        description += 'See plan.md for details.';
      }

      // Determine priority based on section context
      let priority: Task["priority"] = "normal";
      if (phaseName.includes("Phase 1")) {
        priority = "high";
      }

      // Determine domain/classification based on keywords
      let domain: string | undefined;
      const subjectLower = subject.toLowerCase();
      if (subjectLower.includes("test") || subjectLower.includes("qa")) {
        domain = "testing";
      } else if (subjectLower.includes("doc") || subjectLower.includes("readme")) {
        domain = "documentation";
      } else if (subjectLower.includes("plan") || subjectLower.includes("architect")) {
        domain = "architect";
      }

      return {
        id: taskId,
        subject,
        description,
        priority,
        domain,
      };
    }
  }

  return null;
}

function generateTaskId(phaseName: string, subject: string): string {
  const phaseNum = phaseName.replace(/[^0-9.]/g, '');
  const slug = subject.substring(0, 20).toLowerCase().replace(/[^a-z0-9]/g, '-');
  const hash = Buffer.from(subject).toString('base64').substring(0, 4);
  return `${phaseNum}-${slug}-${hash}`;
}

/**
 * Generate full context bundle for a task
 */
export async function generateContextBundle(ctx: PromptContext, taskSubject: string): Promise<ContextBundleResult | null> {
  const { db, projectRoot } = ctx;

  // 1. First try to get task from database
  let task = await getTaskBySubject(db, taskSubject);

  // 2. If not found, search in file-based tasks
  if (!task) {
    const fileTasks = await getTasksFromFiles(projectRoot);
    const matchingTask = fileTasks.find(t => 
      t.id === taskSubject || 
      t.subject.toLowerCase().includes(taskSubject.toLowerCase())
    );
    
    if (matchingTask) {
      // Insert the task into the database for future lookups
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO tasks (id, subject, description, status, priority, domain, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      insertStmt.run(
        matchingTask.id,
        matchingTask.subject,
        matchingTask.description,
        matchingTask.status,
        matchingTask.priority,
        matchingTask.domain || null,
        now,
        now
      );

      task = {
        id: matchingTask.id,
        subject: matchingTask.subject,
        description: matchingTask.description,
        status: matchingTask.status,
        priority: matchingTask.priority,
        domain: matchingTask.domain,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
  }

  if (!task) {
    return null;
  }

  // 3. Get discoveries relevant to the task
  const discoveries = await getOpenDiscoveries(db);

  // 4. Get completed tasks
  const completedTasks = await getCompletedTasks(db);

  // 5. Read plan
  const plan = await readCurrentPlan(projectRoot);

  // 6. Generate instructions based on task classification
  const instructions = generateInstructions(task);

  const fullOutput = buildContextBundle(task, {
    discoveries,
    completedTasks,
    planExcerpt: plan.currentPhase || plan.content,
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
      planExcerpt: plan.currentPhase || plan.content,
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

async function readCurrentPlan(projectRoot: string): Promise<{ content: string; goals: string[]; bullets: string[]; currentPhase: string }> {
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
  let currentPhase = "";

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

  // Extract current phase (the first incomplete phase)
  const lines = content.split("\n");
  let inCurrentPhase = false;
  let phaseContent: string[] = [];
  let foundIncomplete = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const phaseMatch = line.match(/^## (Phase \d+(?:\.\d+)?):/);
    if (phaseMatch) {
      const isComplete = line.includes("✅ Complete");

      if (!isComplete && !foundIncomplete) {
        inCurrentPhase = true;
        phaseContent = [line];
        foundIncomplete = true;
      } else {
        inCurrentPhase = false;
      }
      continue;
    }

    if (inCurrentPhase) {
      if (line.startsWith("## ") && line.match(/^## (Phase \d+(?:\.\d+)?):/)) {
        break;
      }
      phaseContent.push(line);
    }
  }

  currentPhase = phaseContent.join("\n").trim();

  let inGoals = false;
  let inBullets = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
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

  return { content, goals, bullets, currentPhase };
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

async function getTasksFromFiles(projectRoot: string): Promise<Array<{ id: string; subject: string; description: string; status: Task["status"]; priority: Task["priority"]; domain?: string; phase: string }>> {
  const tasks: Array<{ id: string; subject: string; description: string; status: Task["status"]; priority: Task["priority"]; domain?: string; phase: string }> = [];
  
  const currentPath = join(projectRoot, ".project", "tasks", "current.md");
  try {
    const content = await readFile(currentPath, "utf-8");
    const lines = content.split("\n");
    let currentTask: { id: string; subject: string; description: string; priority: Task["priority"] } | null = null;
    let inReady = false;
    let inProgress = false;
    let taskPhase = "";

    // Extract phase from notes at the bottom
    for (const line of lines) {
      const phaseMatch = line.match(/Estimated total for (Phase \d+(?:\.\d+)?)/);
      if (phaseMatch) {
        taskPhase = phaseMatch[1]!;
        break;
      }
    }

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
            phase: taskPhase,
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
        phase: taskPhase,
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


function generateInstructions(task: Task): string {
  let baseInstructions = `## Your Task: ${task.subject}

${task.description}

## Important Context

- You are an AI agent executing a specific task, but this task may already be started by previous iterations or other agents so verify existing code against your acceptance criteria before making changes.
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
${context.planExcerpt.slice(0, 600)}
${context.planExcerpt.length > 600 ? "\n[... more in .project/plan.md ...]" : ""}

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
