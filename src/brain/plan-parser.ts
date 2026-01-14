/**
 * Project Plan Parser
 * 
 * Parses project plan files (.project/plan.md) to extract tasks.
 * Supports the plan format used in Octopai.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

export interface ParsedTask {
  id: string;
  subject: string;
  description: string;
  phase: string;
  priority: "critical" | "high" | "normal" | "low";
  status: "pending" | "in_progress" | "completed";
  sourceRef: string;
  lineNumber: number;
}

export interface PlanParseResult {
  tasks: ParsedTask[];
  phases: string[];
  fileHash: string;
  lastModified: Date;
  errors: string[];
}

/**
 * Parse a plan.md file and extract tasks
 */
export async function parsePlanFile(filePath: string): Promise<PlanParseResult> {
  const errors: string[] = [];
  const tasks: ParsedTask[] = [];
  const phases: Set<string> = new Set();
  
  try {
    const content = await readFile(filePath, "utf-8");
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
        
        // Extract task details
        const taskId = generateTaskId(currentPhase, taskContent);
        const { priority, subject, description } = parseTaskContent(taskContent, sectionDescription);
        
        tasks.push({
          id: taskId,
          subject,
          description: description || sectionDescription.slice(0, 200),
          phase: currentPhase,
          priority,
          status: isCompleted ? "completed" : "pending",
          sourceRef: `${filePath}:${lineNumber}`,
          lineNumber,
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
 * Find all plan files in a directory
 */
export async function findPlanFiles(
  projectRoot: string,
  patterns: string[] = [".project/plan.md", "**/*.plan.md", "**/plans/*.md"]
): Promise<string[]> {
  const { glob } = await import("fast-glob");
  
  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { 
      cwd: projectRoot,
      absolute: true,
    });
    files.push(...matches);
  }
  
  return [...new Set(files)];
}

/**
 * Parse all plan files and return combined tasks
 */
export async function parseAllPlanFiles(
  projectRoot: string
): Promise<PlanParseResult[]> {
  const planFiles = await findPlanFiles(projectRoot);
  const results: PlanParseResult[] = [];
  
  for (const filePath of planFiles) {
    const result = await parsePlanFile(filePath);
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
    metadata: JSON.stringify({
      lineNumber: task.lineNumber,
      importedAt: new Date().toISOString(),
    }),
  }));
}
