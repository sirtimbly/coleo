/**
 * Project Plan Parser
 * 
 * Parses project plan files (.project/plan.md) to extract tasks.
 * Supports the plan format used in Octopai.
 */

import { dirname, join, resolve, sep } from "path";
import { createHash } from "crypto";
import type { WorkspaceAccess } from "../workspace";

export interface ParsedTask {
  id: string;
  subject: string;
  description: string;
  phase: string;
  priority: "critical" | "high" | "normal" | "low";
  status: "pending" | "in_progress" | "completed";
  sourceRef: string;
  lineNumber: number;
  planLineUid?: string;
  tags: string[];
}

export interface PlanParseResult {
  tasks: ParsedTask[];
  phases: string[];
  fileHash: string;
  lastModified: Date;
  errors: string[];
}

async function readPlanText(filePath: string, workspace?: WorkspaceAccess): Promise<{
  content: string;
  contentHash: string | null;
}> {
  if (workspace) {
    const file = await workspace.readText(filePath);
    if (!file) {
      const error = new Error(`Plan file does not exist: ${filePath}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return { content: file.content, contentHash: file.contentHash };
  }
  const content = await import("fs/promises").then(({ readFile }) => readFile(filePath, "utf-8"));
  return { content, contentHash: null };
}

/**
 * Parse a plan.md file and extract tasks
 */
export async function parsePlanFile(
  filePath: string,
  workspace?: WorkspaceAccess,
): Promise<PlanParseResult> {
  const errors: string[] = [];
  const tasks: ParsedTask[] = [];
  const phases: Set<string> = new Set();
  
  try {
    const { content } = await readPlanText(filePath, workspace);
    const fileHash = createHash("sha256").update(content).digest("hex");
    const lines = content.split("\n");
    
    let currentPhase = "";
    let currentSection = "";
    let sectionDescription = "";
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lineNumber = i + 1;
      
      // Detect phase headers (e.g., "## Phase 1: Observatory Foundation")
      const phaseMatch = line.match(/^##\s+(Phase\s+\d+(?:\.\d+)?(?::\s*[^$]+)?)/i);
      if (phaseMatch && phaseMatch[1]) {
        currentPhase = phaseMatch[1].trim();
        phases.add(currentPhase);
        continue;
      }
      
      // Detect section headers (e.g., "### Deliverables", "### Key Decisions Needed")
      const sectionMatch = line.match(/^###\s+(.+)/);
      if (sectionMatch && sectionMatch[1]) {
        currentSection = sectionMatch[1].trim();
        sectionDescription = "";
        continue;
      }
      
      // Track section description (accumulate text after header)
      if (currentSection && line.trim() && !line.startsWith("##") && !line.startsWith("###") && !line.startsWith("- [")) {
        sectionDescription += line.trim() + " ";
      }
      
      // Detect checkbox items (tasks) in deliverables sections
      const checkboxMatch = line.match(/^-\s+\[([ x])\]\s+(.+)/);
      if (checkboxMatch && (currentSection === "Deliverables" || currentSection === "Tasks")) {
        const isCompleted = checkboxMatch[1]?.toLowerCase() === "x";
        const taskContent = checkboxMatch[2]?.trim() ?? "";
        
        // Extract UID from HTML comment if present (e.g., "Task name <!--octopai:abcd1234-->")
        const uidMatch = taskContent.match(/<!--octopai:([a-zA-Z0-9]+)-->$/);
        const planLineUid = uidMatch?.[1];
        const cleanContent = uidMatch ? taskContent.replace(/<!--octopai:[a-zA-Z0-9]+-->$/, "").trim() : taskContent;
        
        // Extract task details
        const taskId = generateTaskId(currentPhase, cleanContent);
        const { priority, subject, description } = parseTaskContent(cleanContent, sectionDescription);
        
        tasks.push({
          id: taskId,
          subject,
          description: description || sectionDescription.slice(0, 200),
          phase: currentPhase,
          priority,
          status: isCompleted ? "completed" : "pending",
          sourceRef: `${filePath}:${lineNumber}`,
          lineNumber,
          planLineUid,
          tags: extractTags(currentPhase, cleanContent),
        });
      }
    }
    
    return {
      tasks,
      phases: Array.from(phases),
      fileHash,
      lastModified: new Date(),
      errors,
    };
  } catch (err) {
    errors.push(`Failed to read or parse ${filePath}: ${err}`);
    return {
      tasks: [],
      phases: [],
      fileHash: "",
      lastModified: new Date(),
      errors,
    };
  }
}

/**
 * Generate a stable task ID from phase and content
 */
function generateTaskId(phase: string, content: string): string {
  const prefix = phase 
    ? phase.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 8) 
    : "task";
  
  // Create a short hash from the content
  const hash = createHash("md5")
    .update(content.slice(0, 50))
    .digest("hex")
    .slice(0, 6);
  
  return `${prefix}-${hash}`;
}

/**
 * Parse task content to extract subject, priority, and description
 */
function parseTaskContent(
  content: string,
  context: string
): { priority: ParsedTask["priority"]; subject: string; description: string } {
  // Check for priority indicators
  let priority: ParsedTask["priority"] = "normal";
  if (/\b(critical|urgent|blocker)\b/i.test(content)) {
    priority = "critical";
  } else if (/\b(high|important|soon)\b/i.test(content)) {
    priority = "high";
  } else if (/\b(low|nice to have)\b/i.test(content)) {
    priority = "low";
  }
  
  // Clean up the subject (remove priority markers)
  const subject = content
    .replace(/\b(critical|urgent|high|important|low|nice to have)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  
  // Extract description (look for additional context after task name)
  const description = content;
  
  return { priority, subject, description };
}

/**
 * Extract tags from phase and task content
 * Tags include: phase number, frontend/backend if mentioned
 */
function extractTags(phase: string, content: string): string[] {
  const tags: string[] = [];

  // Add phase tag (extract just the phase number like "Phase 2", "Phase 2.5")
  if (phase) {
    const phaseMatch = phase.match(/^Phase\s+(\d+(?:\.\d+)?)/i);
    if (phaseMatch) {
      tags.push(`phase-${phaseMatch[1]}`);
    } else {
      // Use sanitized phase name as tag
      const sanitized = phase.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 20);
      if (sanitized) {
        tags.push(sanitized);
      }
    }
  }

  // Check for frontend/backend mentions in content (case-insensitive)
  const lowerContent = content.toLowerCase();
  if (/\bfrontend\b/.test(lowerContent)) {
    tags.push("frontend");
  }
  if (/\bbackend\b/.test(lowerContent)) {
    tags.push("backend");
  }

  return tags;
}

/**
 * Find all plan files in a directory
 */
export async function findPlanFiles(
  projectRoot: string,
  workspace?: WorkspaceAccess,
): Promise<string[]> {
  const mainPlanPath = join(projectRoot, ".project", "plan.md");
  const files = new Set<string>();

  let mainPlanContent: string | null = null;
  try {
    mainPlanContent = (await readPlanText(mainPlanPath, workspace)).content;
    files.add(mainPlanPath);
  } catch {
    mainPlanContent = null;
  }

  if (mainPlanContent) {
    const referenced = await collectReferencedPlanFiles(
      mainPlanContent,
      mainPlanPath,
      projectRoot,
      workspace,
    );
    referenced.forEach((filePath) => files.add(filePath));
    return [...files];
  }

  return [...files];
}

async function collectReferencedPlanFiles(
  content: string,
  mainPlanPath: string,
  projectRoot: string,
  workspace?: WorkspaceAccess,
): Promise<string[]> {
  const results: string[] = [];
  const planDir = dirname(mainPlanPath);
  const projectDir = resolve(projectRoot, ".project") + sep;
  const matches = content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);

  for (const match of matches) {
    const rawPath = match[1]?.trim();
    if (!rawPath) {
      continue;
    }

    if (/^[a-z]+:/i.test(rawPath)) {
      continue;
    }

    const cleanedPath = rawPath.split("#")[0]?.split("?")[0]?.trim();
    if (!cleanedPath || !cleanedPath.endsWith(".md")) {
      continue;
    }

    const resolvedPath = resolve(planDir, cleanedPath);
    if (!resolvedPath.startsWith(projectDir)) {
      continue;
    }

    try {
      if (workspace) {
        if (await workspace.readText(resolvedPath)) results.push(resolvedPath);
      } else {
        await import("fs/promises").then(({ stat }) => stat(resolvedPath));
        results.push(resolvedPath);
      }
    } catch {
      continue;
    }
  }

  return results;
}

/**
 * Parse all plan files and return combined tasks
 */
export async function parseAllPlanFiles(
  projectRoot: string,
  workspace?: WorkspaceAccess,
): Promise<PlanParseResult[]> {
  const planFiles = await findPlanFiles(projectRoot, workspace);
  const results: PlanParseResult[] = [];
  
  for (const filePath of planFiles) {
    const result = await parsePlanFile(filePath, workspace);
    results.push(result);
  }
  
  return results;
}

/**
 * Convert parsed tasks to database format
 */
export function tasksToDatabaseFormat(
  tasks: ParsedTask[],
  sourceType: "plan" = "plan"
): Array<{
  id: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  source_type: string;
  source_ref: string;
  phase: string;
  plan_line_uid?: string;
  tags: string;
  metadata: string;
}> {
  return tasks.map(task => ({
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    priority: task.priority,
    source_type: sourceType,
    source_ref: task.sourceRef,
    phase: task.phase || "",
    plan_line_uid: task.planLineUid,
    tags: JSON.stringify(task.tags),
    metadata: JSON.stringify({
      lineNumber: task.lineNumber,
      importedAt: new Date().toISOString(),
    }),
  }));
}

/**
 * Generate a short UID for plan.md line linking (8 alphanumeric chars)
 */
export function generatePlanLineUid(): string {
  return createHash("md5")
    .update(Date.now().toString() + Math.random().toString())
    .digest("hex")
    .slice(0, 8);
}

/**
 * Insert or update UID comment in a plan.md line
 */
function insertUidInLine(line: string, uid: string): string {
  // Check if line already has an octopai UID comment
  const hasUidMatch = line.match(/<!--octopai:[a-zA-Z0-9]+-->$/);
  if (hasUidMatch) {
    // Replace existing UID
    return line.replace(/<!--octopai:[a-zA-Z0-9]+-->$/, `<!--octopai:${uid}-->`);
  }
  // Add new UID at end of line
  return `${line.trim()} <!--octopai:${uid}-->`;
}

/**
 * Remove a line from plan.md by its UID
 */
export async function removeTaskLineFromPlan(
  filePath: string,
  uid: string,
  workspace?: WorkspaceAccess,
): Promise<boolean> {
  try {
    const source = await readPlanText(filePath, workspace);
    const content = source.content;
    const lines = content.split("\n");
    
    // Find the line with the matching UID
    const matchingIndex = lines.findIndex(line => line.includes(`<!--octopai:${uid}-->`));
    if (matchingIndex === -1) {
      return false;
    }
    
    // Remove the entire line
    lines.splice(matchingIndex, 1);
    
    // Write back the modified content
    if (workspace) {
      await workspace.writeText(filePath, lines.join("\n"), { expectedHash: source.contentHash });
    } else {
      await import("fs/promises").then(({ writeFile }) => writeFile(filePath, lines.join("\n"), "utf-8"));
    }
    return true;
  } catch (err) {
    console.error(`Failed to remove task line from ${filePath}:`, err);
    return false;
  }
}
