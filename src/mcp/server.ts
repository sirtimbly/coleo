/**
 * MCP Server for Octopai Brain
 *
 * Exposes tools and resources that arms can use to:
 * - Claim and complete tasks
 * - Report discoveries
 * - Request approvals
 * - Share notes with other arms
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Task, Discovery, Note, QueueMessage } from "../types";
import { writeFile, readFile, mkdir, readdir, stat } from "fs/promises";
import { join } from "path";
import { randomBytes, createHash } from "crypto";
import { Database } from "bun:sqlite";
import { getOctopaiDir } from "../config";

// Get octopai directory from env or default (project-local)
const OCTOPAI_DIR = getOctopaiDir();
const ARM_ID = process.env.OCTOPAI_ARM_ID || process.env.OCTOPAI_TENTACLE_ID || "unknown";
const PROJECT_ROOT = process.env.OCTOPAI_PROJECT_ROOT || process.cwd();

// Database connection (lazy initialization)
let db: Database | null = null;
let dbWritable: Database | null = null;

function getDatabase(readonly = true): Database {
  if (readonly) {
    if (!db) {
      const dbPath = join(OCTOPAI_DIR, "octopai.db");
      db = new Database(dbPath, { readonly: true });
    }
    return db;
  } else {
    if (!dbWritable) {
      const dbPath = join(OCTOPAI_DIR, "octopai.db");
      dbWritable = new Database(dbPath);
    }
    return dbWritable;
  }
}

/**
 * Log an activity to the database
 */
function logActivity(actor: string, action: string, target?: string, details?: Record<string, unknown>): void {
  try {
    const database = getDatabase(false);
    const now = new Date().toISOString();
    database.run(
      `INSERT INTO activity (timestamp, actor, action, target, details) VALUES (?, ?, ?, ?, ?)`,
      [now, actor, action, target || null, JSON.stringify(details || {})]
    );
  } catch {
    // Activity logging is best-effort
  }
}

/**
 * Write a message to the brain's queue
 */
async function sendToBrain(message: Omit<QueueMessage, "id" | "timestamp">): Promise<string> {
  const queueDir = join(OCTOPAI_DIR, "queue", "brain", "pending");
  await mkdir(queueDir, { recursive: true });

  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const fullMessage: QueueMessage = {
    ...message,
    id,
    timestamp: new Date(),
  };

  const filename = `${id}-${message.from}-${message.type}.json`;
  await writeFile(
    join(queueDir, filename),
    JSON.stringify(fullMessage, null, 2),
    "utf-8"
  );

  return id;
}

// TODO : The arms need a way of recognizing when they're in conflict with each other, when one is attempting to make changes to the same file that the other one is. So when it notices that a file is changed since the agent last worked on it unexpectedly, then it should be able to send that information up to the brain and the brain can distribute that information to the rest of the arms so that they know that whoever's working on this file, this other arm is reporting that things are changing out from underneath it. And then the brain should help resolve conflict. So if two arms claim a certain file that they're working on currently, then the brain needs to either allow them to work together because they're not going to conflict because they're working on different parts of the code and the brain should say okay arm one split the code into these files arm two you can do this in this file and this in the other file. So it should resolve conflicts and it should grant priority to whichever one is most important or looks like it's most likely to succeed or is doing the most important work on that file and then it should notify when those locks are released

/**
 * Read pending tasks for this arm (from SQLite database)
 * Returns tasks that are:
 * 1. Assigned to this arm, OR
 * 2. Unassigned (any arm can claim them), OR
 * 3. Assigned to no one and have a domain preference (arm can still claim if no better match)
 */
async function getPendingTasks(): Promise<Task[]> {
  const tasks: Task[] = [];
  
  // Try to read from SQLite database
  try {
    const database = getDatabase();
    
    // Get all pending/claimed tasks that this arm could work on
    // Be permissive - any idle arm should be able to pick up unassigned work
    const dbTasks = database.query(`
      SELECT id, subject, description, status, priority, phase, domain, assigned_to, metadata, created_at, updated_at
      FROM tasks
      WHERE status IN ('pending', 'claimed')
      AND (
        assigned_to = ?           -- Tasks assigned to this arm
        OR assigned_to IS NULL    -- Unassigned tasks (any arm can claim)
      )
      ORDER BY 
        CASE WHEN assigned_to = ? THEN 0 ELSE 1 END,  -- Prioritize tasks assigned to this arm
        CASE priority 
          WHEN 'critical' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'normal' THEN 3 
          WHEN 'low' THEN 4 
        END,
        created_at ASC
    `).all(ARM_ID, ARM_ID) as Array<{
      id: string;
      subject: string;
      description: string;
      status: string;
      priority: string;
      phase: string | null;
      domain: string | null;
      assigned_to: string | null;
      metadata: string;
      created_at: string;
      updated_at: string;
    }>;
    
    for (const row of dbTasks) {
      tasks.push({
        id: row.id,
        subject: row.subject,
        description: row.description,
        status: row.status as Task["status"],
        priority: row.priority as Task["priority"],
        assignedTo: row.assigned_to || undefined,
        domain: row.domain || undefined,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        artifacts: [],
      });
    }
  } catch {
    // Database not available
  }
  
  return tasks;
}

/**
 * Get instructions/tasks assigned to this arm by the brain
 * Returns tasks that are:
 * 1. Assigned to this arm (highest priority)
 * 2. Unassigned and pending (arm can claim them)
 */
async function getMyInstructions(): Promise<{ tasks: Task[]; messages: QueueMessage[] }> {
  const tasks: Task[] = [];
  const messages: QueueMessage[] = [];
  
  // Try to read from SQLite database first
  try {
    const database = getDatabase();
    
    // Get tasks: assigned to this arm, OR pending/unassigned (any arm can claim)
    const dbTasks = database.query(`
      SELECT id, subject, description, status, priority, phase, domain, assigned_to, metadata, created_at, updated_at
      FROM tasks
      WHERE status IN ('pending', 'claimed', 'in_progress')
      AND (
        assigned_to = ?           -- Tasks assigned to this arm
        OR assigned_to IS NULL    -- Unassigned tasks (any arm can claim)
      )
      ORDER BY 
        CASE WHEN assigned_to = ? THEN 0 ELSE 1 END,  -- Prioritize tasks assigned to this arm
        CASE priority 
          WHEN 'critical' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'normal' THEN 3 
          WHEN 'low' THEN 4 
        END,
        created_at ASC
    `).all(ARM_ID, ARM_ID) as Array<{
      id: string;
      subject: string;
      description: string;
      status: string;
      priority: string;
      phase: string | null;
      domain: string | null;
      assigned_to: string | null;
      metadata: string;
      created_at: string;
      updated_at: string;
    }>;
    
    for (const row of dbTasks) {
      tasks.push({
        id: row.id,
        subject: row.subject,
        description: row.description,
        status: row.status as Task["status"],
        priority: row.priority as Task["priority"],
        assignedTo: row.assigned_to || undefined,
        domain: row.domain || undefined,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        artifacts: [],
      });
    }
  } catch {
    // Database not available, fall back to queue directory
  }
  
  // Also check the queue directory for task assignment messages
  const queueDir = join(OCTOPAI_DIR, "queue", "arms", ARM_ID);
  try {
    const files = await readdir(queueDir);
    for (const file of files.sort()) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(queueDir, file), "utf-8");
        const message: QueueMessage = JSON.parse(content);
        messages.push(message);
        
        if (message.type === "task_assignment" && message.payload) {
          const task = message.payload as Task;
          // Avoid duplicates
          if (!tasks.find(t => t.id === task.id)) {
            tasks.push(task);
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Queue doesn't exist yet
  }
  
  return { tasks, messages };
}

/**
 * Read shared notes
 */
async function getSharedNotes(tags?: string[]): Promise<Note[]> {
  const notesDir = join(OCTOPAI_DIR, "state", "notes", "shared");
  try {
    const files = await readdir(notesDir);
    const notes: Note[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(join(notesDir, file), "utf-8");
      const note: Note = JSON.parse(content);

      // Filter by tags if provided
      if (tags && tags.length > 0) {
        if (!tags.some(t => note.tags.includes(t))) continue;
      }

      notes.push(note);
    }

    return notes;
  } catch {
    return [];
  }
}

/**
 * Create and configure the MCP server
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "octopai-brain",
    version: "0.1.0",
  });

  // ============================================
  // TOOLS - Actions arms can perform
  // ============================================

  // Claim a task from the queue
  server.registerTool(
    "claim_task",
    {
      description: "Claim a pending task to work on",
      inputSchema: {
        task_id: z.string().describe("The ID of the task to claim"),
      },
    },
    async ({ task_id }) => {
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "task_assignment",
        payload: {
          action: "claim",
          taskId: task_id,
        },
      });

      logActivity(ARM_ID, "claim_task", task_id, { messageId });

      return {
        content: [
          {
            type: "text" as const,
            text: `Task ${task_id} claim request sent (message: ${messageId}). Brain will confirm assignment.`,
          },
        ],
      };
    }
  );

  // Complete a task
  server.registerTool(
    "complete_task",
    {
      description: "Mark a task as complete with a summary",
      inputSchema: {
        task_id: z.string().describe("The ID of the task"),
        summary: z.string().describe("Summary of what was done"),
        artifacts: z.array(z.string()).optional().describe("Related artifacts (commit hashes, file paths, etc.)"),
      },
      },
    async ({ task_id, summary, artifacts }) => {
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "task_complete",
        payload: {
          taskId: task_id,
          summary,
          artifacts: artifacts || [],
        },
      });

      logActivity(ARM_ID, "complete_task", task_id, { messageId, artifactCount: (artifacts || []).length });

      return {
        content: [
          {
            type: "text" as const,
            text: `Task ${task_id} marked complete. Summary sent to brain (message: ${messageId}).`,
          },
        ],
      };
    }
  );

  // Report a discovery
  server.registerTool(
    "report_discovery",
    {
      description: "Report something interesting found while working",
      inputSchema: {
        kind: z.enum(["test_failure", "unused_code", "security_issue", "performance", "pattern", "other"])
          .describe("Type of discovery"),
        title: z.string().describe("Brief title"),
        details: z.string().describe("Detailed description"),
        file: z.string().optional().describe("Related file path"),
        line: z.number().optional().describe("Line number if applicable"),
        severity: z.enum(["info", "warning", "error"]).optional().describe("Severity level"),
      },
      },
    async ({ kind, title, details, file, line, severity }) => {
      const discovery: Discovery = {
        kind,
        title,
        details,
        file,
        line,
        severity,
      };

      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "discovery",
        payload: discovery,
      });

      logActivity(ARM_ID, "report_discovery", undefined, { messageId, kind, title, severity, file });

      return {
        content: [
          {
            type: "text" as const,
            text: `Discovery reported: "${title}" (message: ${messageId}). Brain will review and may escalate to human.`,
          },
        ],
      };
    }
  );

  // Request approval from human
  server.registerTool(
    "request_approval",
    {
      description: "Ask the human for approval before taking a significant action",
      inputSchema: {
        action: z.string().describe("What you want to do"),
        context: z.string().describe("Why this needs approval and any relevant details"),
        options: z.array(z.string()).optional().describe("Options for the human to choose from"),
      },
      },
    async ({ action, context, options }) => {
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "approval_request",
        payload: {
          action,
          context,
          options: options || ["Approve", "Reject"],
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Approval request sent (message: ${messageId}). Wait for human response before proceeding.`,
          },
        ],
      };
    }
  );

  // Share a note
  server.registerTool(
    "share_note",
    {
      description: "Share a learning or insight with other arms",
      inputSchema: {
        title: z.string().describe("Title of the note"),
        content: z.string().describe("Content (markdown supported)"),
        tags: z.array(z.string()).describe("Tags for categorization"),
      },
      },
    async ({ title, content, tags }) => {
      const note: Omit<Note, "id" | "createdAt" | "updatedAt"> = {
        author: ARM_ID,
        title,
        content,
        tags,
      };

      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "share_note",
        payload: note,
      });

      logActivity(ARM_ID, "share_note", undefined, { messageId, title, tagCount: tags.length });

      return {
        content: [
          {
            type: "text" as const,
            text: `Note "${title}" shared (message: ${messageId}). Brain will distribute to relevant arms.`,
          },
        ],
      };
    }
  );

  // Share a discovered tool
  server.registerTool(
    "share_tool",
    {
      description: "Share a useful command or tool you discovered",
      inputSchema: {
        name: z.string().describe("Short name for the tool"),
        command: z.string().describe("The command to run"),
        description: z.string().describe("What it does"),
        context: z.string().optional().describe("When to use it"),
      },
      },
    async ({ name, command, description, context }) => {
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "tool_discovery",
        payload: {
          name,
          command,
          description,
          context,
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Tool "${name}" shared (message: ${messageId}). Brain will add to shared toolbox.`,
          },
        ],
      };
    }
  );

  // Get my instructions from the brain
  server.registerTool(
    "get_my_instructions",
    {
      description: "Get tasks and instructions assigned to this arm by the brain. Call this when you first start to see what you should work on.",
      inputSchema: {},
      },
    async () => {
      const { tasks, messages } = await getMyInstructions();
      
      // Log the activity
      logActivity(ARM_ID, "get_my_instructions", undefined, { 
        taskCount: tasks.length, 
        messageCount: messages.length,
        hasPendingTasks: tasks.length > 0 
      });
      
      if (tasks.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No tasks assigned yet. You can:\n1. Wait for the brain to assign a task\n2. Use 'claim_task' to claim a pending task\n3. Explore the codebase and report discoveries`,
            },
          ],
        };
      }
      
      const taskList = tasks.map(t => 
        `## Task: ${t.subject}\n**ID:** ${t.id}\n**Priority:** ${t.priority}\n**Status:** ${t.status}\n\n${t.description}`
      ).join("\n\n---\n\n");
      
      return {
        content: [
          {
            type: "text" as const,
            text: `# Your Assigned Tasks\n\n${taskList}\n\n---\n\nWhen done with a task, use 'complete_task' to report completion.`,
          },
        ],
      };
    }
  );

  // Acknowledge receipt of instructions
  server.registerTool(
    "acknowledge_task",
    {
      description: "Acknowledge that you've received and started working on a task",
      inputSchema: {
        task_id: z.string().describe("The ID of the task"),
      },
      },
    async ({ task_id }) => {
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "status_update",
        payload: {
          taskId: task_id,
          status: "in_progress",
          message: "Task acknowledged and work started",
        },
      });

      logActivity(ARM_ID, "acknowledge_task", task_id, { messageId, status: "in_progress" });

      return {
        content: [
          {
            type: "text" as const,
            text: `Task ${task_id} acknowledged. Brain has been notified that you're working on it.`,
          },
        ],
      };
    }
  );

  // Heartbeat - report that this arm is still alive
  server.registerTool(
    "heartbeat",
    {
      description: "Report that this arm is still alive and working. Call this periodically (every 30-60 seconds) to let the brain know you're active. The brain will mark arms as stopped if they don't heartbeat for too long.",
      inputSchema: {
        status: z.enum(["idle", "busy", "thinking"]).optional().describe("Current status"),
        current_task: z.string().optional().describe("What you're currently working on"),
      },
      },
    async ({ status, current_task }) => {
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "heartbeat",
        payload: {
          status: status || "idle",
          currentTask: current_task,
          timestamp: new Date().toISOString(),
        },
      });

      logActivity(ARM_ID, "heartbeat", undefined, { messageId, status: status || "idle", current_task });

      return {
        content: [
          {
            type: "text" as const,
            text: `Heartbeat sent. Brain knows you're alive.`,
          },
        ],
      };
    }
  );

  // ============================================
  // FILE CLAIM SYSTEM TOOLS - Coordinate file access between arms
  // ============================================

  // Claim a file for read, write, or exclusive access
  server.registerTool(
    "claim_file",
    {
      description: "Request exclusive access to a file to prevent conflicts with other arms",
      inputSchema: {
        file_path: z.string().describe("Path to the file to claim (relative to project root)"),
        claim_type: z.enum(["read", "write", "exclusive"]).optional().describe("Type of claim (default: read)"),
        reason: z.string().optional().describe("Brief explanation of why you need this file"),
      },
    },
    async ({ file_path, claim_type = "read", reason }) => {
      try {
        const database = getDatabase(false);
        const now = new Date().toISOString();
        
        // Check if arm exists
        const arm = database.query("SELECT id FROM arms WHERE id = ?").get(ARM_ID);
        if (!arm) {
          logActivity(ARM_ID, "claim_file_failed", file_path, { error: "arm_not_found", claim_type, reason });
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to claim ${file_path}: Arm ${ARM_ID} not found in database`,
              },
            ],
          };
        }

        // Check for exclusive claim conflicts
        if (claim_type === "exclusive") {
          const existing = database
            .query("SELECT arm_id FROM claims WHERE file_path = ? AND released_at IS NULL")
            .get(file_path) as { arm_id: string } | null;
          if (existing && existing.arm_id !== ARM_ID) {
            logActivity(ARM_ID, "claim_file_failed", file_path, { error: "exclusive_conflict", claim_type, reason, existing_arm: existing.arm_id });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Cannot claim ${file_path} exclusively: File already claimed by ${existing.arm_id}`,
                },
              ],
            };
          }
        }

        // Check if this arm already has a claim on this file
        const existingClaim = database
          .query("SELECT id, claim_type FROM claims WHERE arm_id = ? AND file_path = ? AND released_at IS NULL")
          .get(ARM_ID, file_path) as { id: number; claim_type: string } | null;

        if (existingClaim) {
          // Update existing claim
          database.run(
            "UPDATE claims SET claim_type = ?, claimed_at = ? WHERE id = ?",
            [claim_type, now, existingClaim.id]
          );
          
          logActivity(ARM_ID, "claim_file_updated", file_path, { claim_type, reason, previous_type: existingClaim.claim_type });
          
          return {
            content: [
              {
                type: "text" as const,
                text: `Updated claim on ${file_path}: ${existingClaim.claim_type} → ${claim_type}${reason ? `\nReason: ${reason}` : ""}`,
              },
            ],
          };
        } else {
          // Create new claim
          const result = database.run(
            "INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)",
            [ARM_ID, file_path, claim_type, now]
          );
          
          logActivity(ARM_ID, "claim_file", file_path, { claim_type, reason, claim_id: result.lastInsertRowid });
          
          return {
            content: [
              {
                type: "text" as const,
                text: `Successfully claimed ${file_path} (${claim_type})${reason ? `\nReason: ${reason}` : ""}\n\nOther arms will see this file as owned by you.`,
              },
            ],
          };
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logActivity(ARM_ID, "claim_file_failed", file_path, { error: errorMsg, claim_type, reason });
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to claim ${file_path}: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // Release a file claim
  server.registerTool(
    "release_claim",
    {
      description: "Release your claim on a file so other arms can work on it",
      inputSchema: {
        file_path: z.string().describe("Path to the file to release"),
        reason: z.string().optional().describe("Brief explanation of why you're releasing the claim"),
      },
    },
    async ({ file_path, reason }) => {
      try {
        const database = getDatabase(false);
        const now = new Date().toISOString();
        
        const result = database.run(
          "UPDATE claims SET released_at = ? WHERE arm_id = ? AND file_path = ? AND released_at IS NULL",
          [now, ARM_ID, file_path]
        );

        if (result.changes === 0) {
          logActivity(ARM_ID, "release_claim_failed", file_path, { error: "no_active_claim", reason });
          return {
            content: [
              {
                type: "text" as const,
                text: `No active claim found on ${file_path} to release`,
              },
            ],
          };
        }

        logActivity(ARM_ID, "release_claim", file_path, { reason });
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Released claim on ${file_path}${reason ? `\nReason: ${reason}` : ""}\n\nOther arms can now claim this file.`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logActivity(ARM_ID, "release_claim_failed", file_path, { error: errorMsg, reason });
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to release claim on ${file_path}: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // Check for conflicts on a file
  server.registerTool(
    "check_conflicts",
    {
      description: "Check if a file has conflicting claims or if it's safe to work on",
      inputSchema: {
        file_path: z.string().describe("Path to the file to check"),
      },
    },
    async ({ file_path }) => {
      try {
        const database = getDatabase();
        
        // Get all active claims on this file
        const claims = database.query(
          `SELECT arm_id, claim_type, claimed_at FROM claims 
           WHERE file_path = ? AND released_at IS NULL 
           ORDER BY claimed_at ASC`
        ).all(file_path) as Array<{ arm_id: string; claim_type: string; claimed_at: string }>;

        if (claims.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `✅ ${file_path} is available - no active claims`,
              },
            ],
          };
        }

        if (claims.length === 1) {
          const claim = claims[0];
          if (!claim) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `⚠️ ${file_path} has unexpected claim data`,
                },
              ],
            };
          }

          if (claim.arm_id === ARM_ID) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✅ ${file_path} is claimed by you (${claim.claim_type}) since ${claim.claimed_at}`,
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `⚠️ ${file_path} is claimed by ${claim.arm_id} (${claim.claim_type}) since ${claim.claimed_at}`,
                },
              ],
            };
          }
        }

        // Multiple claims - conflict zone
        const claimList = claims.map(c => `${c.arm_id} (${c.claim_type})`).join(", ");
        const yourClaim = claims.find(c => c.arm_id === ARM_ID);
        
        logActivity(ARM_ID, "check_conflicts", file_path, { conflict: true, claim_count: claims.length, arms: claims.map(c => c.arm_id) });

        return {
          content: [
            {
              type: "text" as const,
              text: `🔥 CONFLICT ZONE: ${file_path}\n\nMultiple claims: ${claimList}\n\n${yourClaim ? "You have a claim on this file. Coordinate with other arms before making changes." : "Consider requesting approval before claiming this contested file."}`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to check conflicts for ${file_path}: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // Transfer a claim to another arm
  server.registerTool(
    "transfer_claim",
    {
      description: "Transfer your file claim to another arm (requires coordination)",
      inputSchema: {
        file_path: z.string().describe("Path to the file to transfer"),
        to_arm: z.string().describe("ID of the arm to transfer the claim to"),
        reason: z.string().describe("Reason for the transfer"),
      },
    },
    async ({ file_path, to_arm, reason }) => {
      try {
        const database = getDatabase(false);
        
        // Check if target arm exists
        const targetArm = database.query("SELECT id FROM arms WHERE id = ?").get(to_arm);
        if (!targetArm) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot transfer claim: Target arm ${to_arm} not found`,
              },
            ],
          };
        }

        // Check if we have an active claim
        const ourClaim = database.query(
          "SELECT id, claim_type FROM claims WHERE arm_id = ? AND file_path = ? AND released_at IS NULL"
        ).get(ARM_ID, file_path) as { id: number; claim_type: string } | null;

        if (!ourClaim) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No active claim found on ${file_path} to transfer`,
              },
            ],
          };
        }

        // Check if target arm already has a claim
        const theirClaim = database.query(
          "SELECT id FROM claims WHERE arm_id = ? AND file_path = ? AND released_at IS NULL"
        ).get(to_arm, file_path);

        if (theirClaim) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot transfer: ${to_arm} already has a claim on ${file_path}`,
              },
            ],
          };
        }

        // Update claim ownership
        const now = new Date().toISOString();
        database.run(
          "UPDATE claims SET arm_id = ?, claimed_at = ? WHERE id = ?",
          [to_arm, now, ourClaim.id]
        );

        // Notify the brain about the transfer
        const messageId = await sendToBrain({
          from: ARM_ID,
          to: "brain",
          type: "claim_transfer",
          payload: {
            filePath: file_path,
            fromArm: ARM_ID,
            toArm: to_arm,
            claimType: ourClaim.claim_type,
            reason,
          },
        });

        logActivity(ARM_ID, "transfer_claim", file_path, { to_arm, reason, claim_type: ourClaim.claim_type, message_id: messageId });
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Transferred ${ourClaim.claim_type} claim on ${file_path} to ${to_arm}\n\nReason: ${reason}\n\nBrain notified (message: ${messageId})`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to transfer claim: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // Get your current file claims
  server.registerTool(
    "list_my_claims",
    {
      description: "List all files you currently have claimed",
      inputSchema: {},
    },
    async () => {
      try {
        const database = getDatabase();
        
        const claims = database.query(
          `SELECT file_path, claim_type, claimed_at FROM claims 
           WHERE arm_id = ? AND released_at IS NULL 
           ORDER BY claimed_at DESC`
        ).all(ARM_ID) as Array<{ file_path: string; claim_type: string; claimed_at: string }>;

        if (claims.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "You have no active file claims.",
              },
            ],
          };
        }

        const claimList = claims.map(c => `- ${c.file_path} (${c.claim_type}) - claimed ${c.claimed_at}`).join("\n");
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Your active file claims (${claims.length}):\n\n${claimList}\n\nUse 'release_claim' to release files you're done with.`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list claims: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // Pre-file operation check (before editing files)
  server.registerTool(
    "pre_file_operation",
    {
      description: "Call this before editing any files to check claims and get permission",
      inputSchema: {
        file_path: z.string().describe("Path to the file you want to operate on"),
        operation: z.enum(["read", "write", "delete", "create"]).describe("Type of operation"),
        estimated_duration: z.number().optional().describe("Estimated operation duration in minutes"),
      },
    },
    async ({ file_path, operation, estimated_duration }) => {
      try {
        // Import the enforcement functions
        const { canWriteToFile, autoClaimFile, getDatabase: getClaimDatabase } = await import("../arm/claim-enforcement");
        const database = getClaimDatabase(false);
        
        // Check if operation is allowed
        if (operation === "write" || operation === "delete" || operation === "create") {
          const result = canWriteToFile(database, ARM_ID, file_path);
          
          if (!result.canWrite) {
            logActivity(ARM_ID, "pre_file_operation_blocked", file_path, { 
              operation, 
              reason: result.reason,
              estimated_duration 
            });
            
            return {
              content: [
                {
                  type: "text" as const,
                  text: `❌ File operation blocked: ${result.reason}\n\nUse 'claim_file' tool to request access or 'check_conflicts' to see current claims.`,
                },
              ],
            };
          }
          
          // Auto-claim if suggested
          if (result.shouldClaim) {
            const claimType = operation === "write" || operation === "delete" || operation === "create" ? "write" : "read";
            const claimed = autoClaimFile(database, ARM_ID, file_path, claimType);
            
            logActivity(ARM_ID, "pre_file_operation_auto_claim", file_path, { 
              operation, 
              claim_type: claimType,
              claimed,
              estimated_duration 
            });
            
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✅ File operation approved for ${file_path}\n${claimed ? `Auto-claimed file (${claimType} access)` : "Operation allowed"}\n\nProceed with your ${operation} operation.`,
                },
              ],
            };
          }
        }
        
        logActivity(ARM_ID, "pre_file_operation_approved", file_path, { operation, estimated_duration });
        
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ File operation approved for ${file_path} (${operation})`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logActivity(ARM_ID, "pre_file_operation_failed", file_path, { error: errorMsg, operation });
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking file operation permission: ${errorMsg}\n\nProceeding with operation (fail-open mode)`,
            },
          ],
        };
      }
    }
  );

  // Post-file operation reporting (after editing files)
  server.registerTool(
    "post_file_operation",
    {
      description: "Call this after editing files to report completion and detect conflicts",
      inputSchema: {
        file_path: z.string().describe("Path to the file that was operated on"),
        operation: z.enum(["read", "write", "delete", "create"]).describe("Type of operation performed"),
        success: z.boolean().describe("Whether the operation succeeded"),
        changes_summary: z.string().optional().describe("Brief summary of changes made"),
      },
    },
    async ({ file_path, operation, success, changes_summary }) => {
      try {
        // Import the enforcement functions
        const { checkAndEscalateIfThrashing, getDatabase: getClaimDatabase } = await import("../arm/claim-enforcement");
        const database = getClaimDatabase(false);
        
        // Log the activity for thrashing detection
        logActivity(ARM_ID, `file_${operation}`, file_path, {
          success,
          changes_summary,
          timestamp: new Date().toISOString(),
        });
        
        // Check for thrashing if this was a write operation
        if ((operation === "write" || operation === "create") && success) {
          checkAndEscalateIfThrashing(database, file_path);
        }
        
        database.close();
        
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ File operation logged: ${file_path} (${operation})${success ? "" : " - FAILED"}\n${changes_summary ? `Changes: ${changes_summary}` : ""}\n\nThrashing detection updated.`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Error logging file operation: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // Get current claim mode
  server.registerTool(
    "get_claim_mode",
    {
      description: "Get the current file claim enforcement mode",
      inputSchema: {},
    },
    async () => {
      try {
        const { getClaimMode, getClaimEnforcementConfig, getDatabase: getClaimDatabase } = await import("../arm/claim-enforcement");
        const database = getClaimDatabase();
        const mode = getClaimMode(database);
        const config = getClaimEnforcementConfig(database);
        database.close();
        
        const modeDescriptions = {
          strict: "Must claim files before writing. Conflicts are blocked.",
          lazy: "Claims optional. Conflicts detected after the fact with auto-escalation.",
          disabled: "No claim enforcement. Parallel writes allowed.",
        };
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Current claim mode: **${mode}**\n\n${modeDescriptions[mode]}\n\nConfiguration:\n- Auto-claim on write: ${config.autoClaimOnWrite}\n- Block on conflict: ${config.blockOnConflict}\n- Thrashing detection: ${config.enableThrashingDetection}`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting claim mode: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // ============================================
  // DOCUMENTATION AWARENESS TOOLS - Stay in sync with project docs
  // ============================================

  // Get documentation content
  server.registerTool(
    "get_documentation",
    {
      description: "Read documentation content from the docs/ directory. Use this to understand project requirements, plans, and architectural decisions. Always check relevant docs before starting work on a task.",
      inputSchema: {
        path: z.string().optional().describe("Relative path from docs/ (e.g., 'architecture/overview.md' or 'plans/phase1.md'). Leave empty to list available docs."),
      },
      },
    async ({ path }) => {
      if (!path) {
        // List available documentation
        const docsDir = join(PROJECT_ROOT, "docs");
        const categories: Record<string, string[]> = {
          architecture: [],
          guides: [],
          plans: [],
          requirements: [],
          decisions: [],
          other: [],
        };

        try {
          const listDocs = async (dir: string, baseRel: string = "") => {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = join(dir, entry.name);
              const relPath = baseRel ? `${baseRel}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                await listDocs(fullPath, relPath);
              } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
                let category: string = "other";
                const parts = relPath.split("/");
                if (parts[0] === "architecture") category = "architecture";
                else if (parts[0] === "guides") category = "guides";
                else if (parts[0] === "plans") category = "plans";
                else if (parts[0] === "requirements") category = "requirements";
                else if (parts[0] === "decisions") category = "decisions";
                (categories as Record<string, string[]>)[category]!.push(relPath);
              }
            }
          };
          await listDocs(docsDir);

          let listText = "# Available Documentation\n\n";
          for (const [cat, files] of Object.entries(categories)) {
            if (files.length > 0) {
              listText += `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n`;
              for (const f of files) {
                listText += `- docs/${f}\n`;
              }
              listText += "\n";
            }
          }

          return {
            content: [{ type: "text" as const, text: listText }],
          };
        } catch {
          return {
            content: [{ type: "text" as const, text: "No docs/ directory found. Create docs/ to store project documentation." }],
          };
        }
      }

      // Read specific document
      const docPath = join(PROJECT_ROOT, "docs", path);
      try {
        const content = await readFile(docPath, "utf-8");
        const stats = await stat(docPath);

        return {
          content: [
            {
              type: "text" as const,
              text: `# ${path}\n\n---\n\n${content}\n\n---\n\n*Last modified: ${stats.mtime.toISOString()}*`,
            },
          ],
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: `Document not found: docs/${path}` }],
        };
      }
    }
  );

  // Check for documentation changes
  server.registerTool(
    "check_documentation_changes",
    {
      description: "Check if any documentation has changed since you last read it. Call this periodically or when starting a new task to ensure you're working with current information.",
      inputSchema: {
        since: z.string().optional().describe("ISO timestamp to check changes since (default: your session start)"),
        category: z.enum(["architecture", "guides", "plans", "requirements", "decisions", "all"]).optional().describe("Only check changes in this category"),
      },
      },
    async ({ since, category }) => {
      const docsDir = join(PROJECT_ROOT, "docs");
      const changes: Array<{ path: string; modified: Date; hash: string }> = [];
      const checkSince = since ? new Date(since) : new Date();

      try {
        const scanAndCheck = async (dir: string, baseRel: string = "") => {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            const relPath = baseRel ? `${baseRel}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
              await scanAndCheck(fullPath, relPath);
            } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
              // Check if in requested category
              if (category && category !== "all") {
                const docCategory = relPath.split("/")[0];
                if (docCategory !== category) continue;
              }

              const stats = await stat(fullPath);
              if (stats.mtime > checkSince) {
                const content = await readFile(fullPath, "utf-8");
                const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
                changes.push({ path: relPath, modified: stats.mtime, hash });
              }
            }
          }
        };
        await scanAndCheck(docsDir);
      } catch {
        return {
          content: [{ type: "text" as const, text: "Could not scan docs/ directory." }],
        };
      }

      if (changes.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No documentation changes detected since your check time." }],
        };
      }

      const changeList = changes.map(c => `- docs/${c.path} (modified: ${c.modified.toISOString()})`).join("\n");
      
      logActivity(ARM_ID, "check_documentation_changes", undefined, { changeCount: changes.length, category });

      return {
        content: [
          {
            type: "text" as const,
            text: `# Documentation Changes\n\n${changeList}\n\n**Recommendation:** Use 'get_documentation' to re-read these files before continuing.`,
          },
        ],
      };
    }
  );

  // Find relevant documentation for a task
  server.registerTool(
    "find_relevant_docs",
    {
      description: "Find documentation relevant to your current task or work. Provide a description of what you're working on and get recommendations for docs to read.",
      inputSchema: {
        task_description: z.string().describe("Description of your current task or what you're working on"),
        max_results: z.number().optional().describe("Maximum number of docs to return (default: 5)"),
      },
      },
    async ({ task_description, max_results = 5 }) => {
      const keywords = task_description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const docsDir = join(PROJECT_ROOT, "docs");
      const scored: Array<{ path: string; score: number; preview: string }> = [];

      try {
        const scanForRelevance = async (dir: string, baseRel: string = "") => {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            const relPath = baseRel ? `${baseRel}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
              await scanForRelevance(fullPath, relPath);
            } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
              const content = await readFile(fullPath, "utf-8");
              const contentLower = content.toLowerCase();
              const pathLower = relPath.toLowerCase();

              let score = 0;
              for (const keyword of keywords) {
                if (pathLower.includes(keyword)) score += 3;
                if (contentLower.includes(keyword)) score += 1;
              }

              if (score > 0) {
                // Get first 200 chars as preview
                const preview = content.slice(0, 200).replace(/[#*`\n]/g, " ").trim() + "...";
                scored.push({ path: relPath, score, preview });
              }
            }
          }
        };
        await scanForRelevance(docsDir);
      } catch {
        return {
          content: [{ type: "text" as const, text: "Could not scan docs/ directory." }],
        };
      }

      scored.sort((a, b) => b.score - a.score);
      const topDocs = scored.slice(0, max_results);

      if (topDocs.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No particularly relevant documentation found. Try using 'get_documentation' to explore the docs/ directory." }],
        };
      }

      const docList = topDocs.map(d => `## docs/${d.path}\n**Relevance:** ${d.score}\n\n${d.preview}`).join("\n\n---\n\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `# Relevant Documentation for Your Work\n\n${docList}\n\n---\n\nUse 'get_documentation' to read any of these in full.`,
          },
        ],
      };
    }
  );

  // Update documentation
  server.registerTool(
    "update_documentation",
    {
      description: "Update a documentation file with new content. Use this when the human has provided feedback that requires updating docs, requirements, or plans. The brain will be notified of the update.",
      inputSchema: {
        path: z.string().describe("Relative path from docs/ (e.g., 'requirements/auth.md')"),
        content: z.string().describe("The new content for the document"),
        reason: z.string().describe("Brief explanation of why this update is needed (e.g., 'User clarified requirements via email')"),
      },
      },
    async ({ path, content, reason }) => {
      const docPath = join(PROJECT_ROOT, "docs", path);
      
      try {
        // Read existing file to preserve it
        let existingContent = "";
        try {
          existingContent = await readFile(docPath, "utf-8");
        } catch {
          // File doesn't exist, will create new
        }

        // Write the updated content
        await writeFile(docPath, content, "utf-8");

        // Notify brain of the update
        const messageId = await sendToBrain({
          from: ARM_ID,
          to: "brain",
          type: "doc_update",
          payload: {
            path: `docs/${path}`,
            reason,
            previousContent: existingContent,
            newContent: content,
          },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Documentation updated: docs/${path}\n\nReason: ${reason}\n\nBrain notified (message: ${messageId}). Other arms will be notified of this change on their next poll.`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to update docs/${path}: ${errorMsg}` }],
        };
      }
    }
  );

  // Subscribe to watch a file or pattern
  server.registerTool(
    "subscribe_file",
    {
      description: "Subscribe to changes for a file or glob pattern. You will be notified when the file changes. Use this for documentation and requirements files relevant to your current task.",
      inputSchema: {
        pattern: z.string().describe("File path or glob pattern to watch (e.g., 'docs/requirements/*.md' or 'src/api/*.ts')"),
        category: z.enum(["architecture", "guides", "plans", "requirements", "decisions", "other", "source"]).optional().describe("Category for filtering change notifications"),
      },
      },
    async ({ pattern, category }) => {
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "file_subscription",
        payload: {
          action: "subscribe",
          pattern,
          category,
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Subscribed to: ${pattern}${category ? ` (category: ${category})` : ""}\n\nYou will be notified of changes on your next poll cycle.\nBrain notified (message: ${messageId}).`,
          },
        ],
      };
    }
  );

  // Unsubscribe from a file pattern
  server.registerTool(
    "unsubscribe_file",
    {
      description: "Stop watching a file or pattern you previously subscribed to.",
      inputSchema: {
        pattern: z.string().describe("File path or pattern to stop watching"),
      },
      },
    async ({ pattern }) => {
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "file_subscription",
        payload: {
          action: "unsubscribe",
          pattern,
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Unsubscribed from: ${pattern}\n\nBrain notified (message: ${messageId}).`,
          },
        ],
      };
    }
  );

  // Report a file change that was detected
  server.registerTool(
    "report_file_change",
    {
      description: "Report that you detected a file change. The brain will notify other subscribed arms.",
      inputSchema: {
        file_path: z.string().describe("Path to the file that changed (relative to project root)"),
        change_type: z.enum(["created", "modified", "deleted"]).describe("Type of change"),
        summary: z.string().describe("Brief summary of what changed"),
        impact: z.string().optional().describe("Assessment of impact on current work"),
      },
      },
    async ({ file_path, change_type, summary, impact }) => {
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "file_change",
        payload: {
          filePath: file_path,
          changeType: change_type,
          summary,
          impact,
          detectedAt: new Date().toISOString(),
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `File change reported: ${file_path} (${change_type})\n\nSummary: ${summary}${impact ? `\nImpact: ${impact}` : ""}\n\nBrain will notify subscribed arms (message: ${messageId}).`,
          },
        ],
      };
    }
  );

  // ============================================
  // RESOURCES - Data arms can read
  // ============================================

  // List pending tasks
  server.registerResource(
    "List of tasks available to claim",
    "octopai://tasks/pending",
    {},
    async () => {
      const tasks = await getPendingTasks();
      return {
        contents: [
          {
            uri: "octopai://tasks/pending",
            mimeType: "application/json",
            text: JSON.stringify(tasks, null, 2),
          },
        ],
      };
    }
  );

  // Get shared notes
  server.registerResource(
    "Shared knowledge base from all arms",
    "octopai://notes/shared",
    {},
    async () => {
      const notes = await getSharedNotes();
      return {
        contents: [
          {
            uri: "octopai://notes/shared",
            mimeType: "application/json",
            text: JSON.stringify(notes, null, 2),
          },
        ],
      };
    }
  );

  // System status
  server.registerResource(
    "Current system status",
    "octopai://status",
    {},
    async () => {
      const stateFile = join(OCTOPAI_DIR, "state", "brain.json");
      let state = { status: "unknown" };
      try {
        const content = await readFile(stateFile, "utf-8");
        state = JSON.parse(content);
      } catch {
        // State file doesn't exist yet
      }

      return {
        contents: [
          {
            uri: "octopai://status",
            mimeType: "application/json",
            text: JSON.stringify(state, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

/**
 * Run the MCP server (called when invoked as `octopai mcp serve`)
 */
export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error(`[octopai] MCP server started for arm: ${ARM_ID}`);
}
