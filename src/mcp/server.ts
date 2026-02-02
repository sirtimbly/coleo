/**
 * MCP Server for Coleo Brain
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
import { getColeoDir } from "../config";
import { NatsClient, TOPICS, type BrainMessage } from "../nats";
import { eventStore } from "../nats/jetstream";
import { queueMessage, getPendingMessages, markMessageCompleted, getNotes } from "../db/state";
import { broadcast } from "../api/websocket";
import {
  generateTaskDetermination,
  generateContextBundle,
  formatTaskDetermination,
  formatContextBundle,
  type PromptContext,
} from "../brain/prompt-generator";
import {
  getServiceStatus,
  restartService,
  stopService,
  startService,
  isSelfModifyAllowed,
  formatUptime,
  type ServiceType,
} from "../daemon";

// Get coleo directory from env or default (project-local)
const COLEO_DIR = getColeoDir();
const ARM_ID = process.env.COLEO_ARM_ID || process.env.COLEO_TENTACLE_ID || "unknown";
const PROJECT_ROOT = process.env.COLEO_PROJECT_ROOT || process.cwd();
const OPENCOD_API_URL = process.env.OPENCOD_API_URL || "http://127.0.0.1:19300";

// Database connection (lazy initialization)
let db: Database | null = null;
let dbWritable: Database | null = null;

// NATS client (lazy initialization)
let natsClient: NatsClient | null = null;

// Cache for arm's session ID to avoid repeated DB queries
let cachedSessionId: string | null = null;

/**
 * Get the session ID for this arm from the database
 */
async function getArmSessionId(): Promise<string | null> {
  if (cachedSessionId !== null) {
    return cachedSessionId;
  }

  try {
    const database = getDatabase();
    const row = database.query("SELECT session_id FROM arms WHERE id = ?").get(ARM_ID) as { session_id: string } | null;
    cachedSessionId = row?.session_id || null;
    return cachedSessionId;
  } catch (err) {
    console.error(`[MCP] Failed to get session ID for arm ${ARM_ID}: ${err}`);
    return null;
  }
}

// REMOVED: OpenCode event listener moved to harness system
// The harness now forwards events to the main server via callbacks

function getDatabase(readonly = true): Database {
  if (readonly) {
    if (!db) {
      const dbPath = join(COLEO_DIR, "coleo.db");
      db = new Database(dbPath, { readonly: true });
    }
    return db;
  } else {
    if (!dbWritable) {
      const dbPath = join(COLEO_DIR, "coleo.db");
      dbWritable = new Database(dbPath);
    }
    return dbWritable;
  }
}

/**
 * Get or create NATS client
 */
async function getNatsClient(): Promise<NatsClient | null> {
  if (natsClient) return natsClient;
  
  const natsUrl = process.env.COLEO_NATS_URL || "nats://localhost:4222";
  
  try {
    natsClient = new NatsClient({
      serverUrl: natsUrl,
      clientId: `arm-${ARM_ID}`,
      debug: false,
    });
    
    await natsClient.connect();
    console.error(`[MCP] Connected to NATS at ${natsUrl}`);
    return natsClient;
  } catch (err) {
    console.error(`[MCP] NATS not available: ${err}`);
    natsClient = null;
    return null;
  }
}

/**
 * Log an activity to JetStream
 */
function logActivity(actor: string, action: string, target?: string, details?: Record<string, unknown>): void {
  if (eventStore.isInitialized()) {
    const subject = target 
      ? `coleo.events.arm.${target}.${action}`
      : `coleo.events.mcp.${action}`;
    
    eventStore.publishEvent(subject, {
      type: action,
      armId: target,
      data: { actor, ...details },
      timestamp: new Date().toISOString(),
    }).catch(() => {
      // Activity logging is best-effort
    });
  }
}

/**
 * Ensure the arm is registered in the database.
 * This allows "manual arms" (agents started by the user directly) to auto-register
 * when they first call an MCP tool, without requiring `coleo arm spawn`.
 */
function ensureArmRegistered(): void {
  try {
    const database = getDatabase(false);
    const now = new Date().toISOString();
    
    // Check if arm already exists
    const existing = database.query("SELECT id, status FROM arms WHERE id = ?").get(ARM_ID) as { id: string; status: string } | null;
    
    if (existing) {
      // Update last_activity_at and ensure status is running
      database.run(
        `UPDATE arms SET last_activity_at = ?, status = CASE WHEN status = 'stopped' THEN 'running' ELSE status END, updated_at = ? WHERE id = ?`,
        [now, now, ARM_ID]
      );
      return;
    }
    
    // Auto-register as a manual arm
    const armName = ARM_ID.startsWith("arm-") ? ARM_ID : `manual-${ARM_ID}`;
    
    database.run(`
      INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      ARM_ID,
      armName,
      "general",        // domain - can be updated later
      "manual",         // harness - indicates manually started
      "running",        // status
      100000,           // context_budget
      0,                // current_context_used
      now,
      now,
      now,
    ]);
    
    console.error(`[MCP] Auto-registered manual arm: ${ARM_ID}`);
    logActivity(ARM_ID, "arm_auto_registered", ARM_ID, { 
      harness: "manual",
      source: "mcp_tool_call",
    });
  } catch (err) {
    // Best-effort registration - don't fail the tool call
    console.error(`[MCP] Failed to auto-register arm: ${err}`);
  }
}

/**
 * Write a message to the brain's queue (SQLite-based with file fallback)
 */
async function sendToBrainFile(message: QueueMessage): Promise<string> {
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  
  // Try SQLite first (primary)
  try {
    const dbPath = join(COLEO_DIR, "coleo.db");
    const db = new Database(dbPath, { readonly: false });
    try {
      queueMessage(db, {
        id,
        from: message.from,
        to: "brain",
        type: message.type,
        payload: message.payload,
      });
      return id;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`[MCP] Failed to queue message to SQLite, falling back to file: ${err}`);
  }
  
  // Fallback to file-based queue
  const queueDir = join(COLEO_DIR, "queue", "brain", "pending");
  await mkdir(queueDir, { recursive: true });

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

/**
 * Send a message to the brain via NATS (preferred) or file queue (fallback)
 */
async function sendToBrain(message: Omit<QueueMessage, "id" | "timestamp">): Promise<string> {
  const nats = await getNatsClient();
  
  if (nats && nats.connected()) {
    // Send via NATS
    const brainMessage: BrainMessage = {
      from: message.from,
      to: "brain",
      type: message.type,
      payload: message.payload,
      timestamp: new Date().toISOString(),
    };
    
    await nats.publishBrainMessage(brainMessage);
    console.error(`[MCP] Sent ${message.type} to brain via NATS`);
    return `nats-${Date.now()}`;
  }
  
  // Fall back to file queue
  return sendToBrainFile(message as QueueMessage);
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
    
    // Get pending messages from SQLite messages table
    const dbMessages = getPendingMessages(database, ARM_ID);
    for (const msg of dbMessages) {
      const queueMsg: QueueMessage = {
        id: msg.id,
        from: msg.from,
        to: msg.to,
        type: msg.type as QueueMessage["type"],
        payload: msg.payload,
        timestamp: msg.createdAt,
      };
      messages.push(queueMsg);
      
      // Extract task from task_assignment messages
      if (msg.type === "task_assignment" && msg.payload) {
        const task = msg.payload as Task;
        if (!tasks.find(t => t.id === task.id)) {
          tasks.push(task);
        }
      }
      
      // Mark message as completed after reading
      markMessageCompleted(database, msg.id);
    }
    
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
  const queueDir = join(COLEO_DIR, "queue", "arms", ARM_ID);
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
 * Read shared notes (from SQLite with file fallback)
 */
async function getSharedNotes(tags?: string[]): Promise<Note[]> {
  // Try SQLite first
  try {
    const database = getDatabase();
    const dbNotes = getNotes(database, { category: "shared" });
    
    // Filter by tags if provided
    if (tags && tags.length > 0) {
      return dbNotes
        .filter(n => tags.some(t => n.tags.includes(t)))
        .map(n => ({
          id: n.id,
          author: n.author,
          title: n.title,
          content: n.content,
          tags: n.tags,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
        }));
    }
    
    return dbNotes.map(n => ({
      id: n.id,
      author: n.author,
      title: n.title,
      content: n.content,
      tags: n.tags,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    }));
  } catch {
    // Fall back to file-based notes
  }
  
  const notesDir = join(COLEO_DIR, "state", "notes", "shared");
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
    name: "coleo-brain",
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
      console.error(`[MCP] claim_task called by ${ARM_ID} for task ${task_id}`);
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
      console.error(`[MCP] claim_task completed, messageId: ${messageId}`);

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
      console.error(`[MCP] complete_task called by ${ARM_ID} for task ${task_id}`);
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

  // Submit a status report for a task
  server.registerTool(
    "submit_status_report",
    {
      description: "Submit a status report for a task in progress or just completed. Use this to report issues, blockers, or completion with issues that require brain re-evaluation.",
      inputSchema: {
        task_id: z.string().describe("The ID of the task this report is for"),
        status: z.enum(["on_track", "blocked", "issues_found", "needs_review", "completed_with_issues"])
          .describe("Current status: on_track (normal progress), blocked (cannot continue), issues_found (found problems), needs_review (needs human/other arm review), completed_with_issues (done but with problems)"),
        summary: z.string().describe("Summary of current progress or completion state"),
        issues: z.array(z.string()).optional().describe("List of issues discovered during work"),
        blockers: z.array(z.string()).optional().describe("List of blockers preventing progress"),
        next_steps: z.string().optional().describe("Suggested next steps if issues were found"),
        files_changed: z.array(z.string()).optional().describe("List of files modified"),
        tests_status: z.enum(["passing", "failing", "not_run"]).optional().describe("Status of tests if run"),
      },
    },
    async ({ task_id, status, summary, issues, blockers, next_steps, files_changed, tests_status }) => {
      const reportId = `sr-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      
      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "status_report",
        payload: {
          id: reportId,
          taskId: task_id,
          armId: ARM_ID,
          status,
          summary,
          issues: issues || [],
          blockers: blockers || [],
          nextSteps: next_steps,
          filesChanged: files_changed || [],
          testsStatus: tests_status,
        },
      });

      logActivity(ARM_ID, "submit_status_report", task_id, { 
        messageId, 
        reportId, 
        status, 
        issueCount: (issues || []).length,
        blockerCount: (blockers || []).length 
      });

      let responseText = `Status report submitted (${reportId}). Brain will review`;
      if (status === "blocked" || status === "issues_found") {
        responseText += " and may adjust the plan or create verification tasks.";
      } else if (status === "completed_with_issues") {
        responseText += " and may create a 'verify & polish' follow-up task.";
      } else {
        responseText += ".";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: responseText,
          },
        ],
      };
    }
  );

  // Report a discovery
  server.registerTool(
    "report_discovery",
    {
      description: "Report something interesting found while working. Use during exploration phase to report context gaps, ambiguous requirements, blockers, related code, and suggested approaches.",
      inputSchema: {
        kind: z.enum([
          "test_failure", "unused_code", "security_issue", "performance", "pattern",
          "missing_context", "ambiguous_requirement", "potential_blocker", "related_code", "suggested_approach",
          "other"
        ]).describe("Type of discovery: exploration kinds (missing_context, ambiguous_requirement, potential_blocker, related_code, suggested_approach) or implementation kinds (test_failure, unused_code, security_issue, performance, pattern, other)"),
        title: z.string().describe("Brief title"),
        details: z.string().describe("Detailed description"),
        file: z.string().optional().describe("Related file path"),
        line: z.number().optional().describe("Line number if applicable"),
        severity: z.enum(["info", "warning", "error"]).optional().describe("Severity level"),
        task_id: z.string().optional().describe("Task ID this discovery relates to (important for exploration phase)"),
        phase: z.enum(["exploration", "implementation", "verification"]).optional().describe("Phase when discovery was made: exploration (before changes), implementation (during changes), verification (testing/review)"),
      },
      },
    async ({ kind, title, details, file, line, severity, task_id, phase }) => {
      const discovery: Discovery = {
        kind,
        title,
        details,
        file,
        line,
        severity,
        taskId: task_id,
        phase,
      };

      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "discovery",
        payload: discovery,
      });

      logActivity(ARM_ID, "report_discovery", task_id, { messageId, kind, title, severity, file, phase });

      const phaseNote = phase === "exploration" 
        ? " This exploration insight will be shared with other arms working on related tasks."
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Discovery reported: "${title}" (${kind}, ${phase || "implementation"}) (message: ${messageId}).${phaseNote} Brain will review and may escalate to human.`,
          },
        ],
      };
    }
  );

  // Resolve or dismiss a discovery
  server.registerTool(
    "resolve_discovery",
    {
      description: "Mark a discovery as resolved or dismissed. Use when you find that a previously reported blocker, issue, or concern is no longer valid or has been fixed.",
      inputSchema: {
        discovery_id: z.string().optional().describe("The ID of the discovery to resolve (if known)"),
        title_match: z.string().optional().describe("Partial title to match if ID is not known"),
        resolution: z.enum(["resolved", "dismissed"]).describe("resolved = issue was fixed/addressed, dismissed = issue was not actually valid"),
        reason: z.string().describe("Explanation of why this discovery is being resolved/dismissed"),
      },
    },
    async ({ discovery_id, title_match, resolution, reason }) => {
      if (!discovery_id && !title_match) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Must provide either discovery_id or title_match to identify the discovery.",
            },
          ],
        };
      }

      const db = getDatabase();
      if (!db) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Database not available.",
            },
          ],
        };
      }

      const now = new Date().toISOString();
      type DiscoveryRow = { id: string; title: string; kind: string } | null;
      let discovery: DiscoveryRow = null;

      if (discovery_id) {
        // Find by exact ID
        discovery = db.query(`
          SELECT id, title, kind FROM discoveries WHERE id = ? AND status = 'open'
        `).get(discovery_id) as DiscoveryRow;
      } else if (title_match) {
        // Find by title match (most recent open discovery matching the title)
        discovery = db.query(`
          SELECT id, title, kind FROM discoveries 
          WHERE status = 'open' AND title LIKE ? 
          ORDER BY created_at DESC LIMIT 1
        `).get(`%${title_match}%`) as DiscoveryRow;
      }

      if (!discovery) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No open discovery found matching ${discovery_id ? `ID: ${discovery_id}` : `title: "${title_match}"`}. It may already be resolved.`,
            },
          ],
        };
      }

      // Update the discovery status
      db.run(`
        UPDATE discoveries 
        SET status = ?, 
            updated_at = ?,
            metadata = json_set(COALESCE(metadata, '{}'), '$.resolution_reason', ?, '$.resolved_by', ?, '$.resolved_at', ?)
        WHERE id = ?
      `, [resolution, now, reason, ARM_ID, now, discovery.id]);

      // Log the activity
      logActivity(ARM_ID, "resolve_discovery", discovery.id, { 
        title: discovery.title, 
        kind: discovery.kind, 
        resolution, 
        reason 
      });

      // Notify brain about the resolution
      await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "discovery",
        payload: {
          kind: "other" as const,
          title: `Discovery ${resolution}: ${discovery.title}`,
          details: `Arm ${ARM_ID} marked discovery "${discovery.title}" as ${resolution}. Reason: ${reason}`,
          severity: "info" as const,
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Discovery "${discovery.title}" marked as ${resolution}. Reason: ${reason}. This will be reflected in future context bundles.`,
          },
        ],
      };
    }
  );

  // Report task dependency discovered during execution
  server.registerTool(
    "report_dependency",
    {
      description: "Report a dependency relationship discovered during task execution",
      inputSchema: {
        task_id: z.string().describe("The ID of the task this dependency relates to"),
        depends_on: z.string().describe("What this task depends on (file, component, service, etc.)"),
        dependency_type: z.enum(["file", "component", "service", "external", "data", "other"])
          .describe("Type of dependency"),
        description: z.string().describe("Description of the dependency relationship"),
        severity: z.enum(["info", "warning", "blocking"]).optional().describe("How critical this dependency is"),
      },
    },
    async ({ task_id, depends_on, dependency_type, description, severity }) => {
      const dependency = {
        taskId: task_id,
        dependsOn: depends_on,
        type: dependency_type,
        description,
        severity,
      };

      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "dependency_discovery",
        payload: dependency,
      });

      logActivity(ARM_ID, "report_dependency", task_id, {
        messageId,
        dependsOn: depends_on,
        type: dependency_type,
        severity
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Dependency reported: ${depends_on} (${dependency_type}) for task ${task_id} (message: ${messageId}). Brain will track this relationship.`,
          },
        ],
      };
    }
  );

  // Report a bug encountered during execution
  server.registerTool(
    "report_bug",
    {
      description: "Report a bug encountered during task execution. Use this for compilation errors, test failures, runtime crashes, or other issues that prevent task completion.",
      inputSchema: {
        title: z.string().describe("Brief title describing the bug"),
        description: z.string().describe("Detailed description of the bug, including steps to reproduce and error messages"),
        source_task_id: z.string().optional().describe("ID of the task where the bug was encountered"),
        error_details: z.string().optional().describe("JSON string with additional error details like stack traces"),
      },
    },
    async ({ title, description, source_task_id, error_details }) => {
      const bugPayload = {
        id: `bug-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title,
        description,
        source: "arm_reported" as const,
        sourceTaskId: source_task_id,
        errorDetails: error_details,
      };

      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "bug_report",
        payload: bugPayload,
      });

      logActivity(ARM_ID, "report_bug", source_task_id, {
        messageId,
        bugId: bugPayload.id,
        title,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Bug reported: ${title} (message: ${messageId}). Brain will process and may create investigation tasks.`,
          },
        ],
      };
    }
  );

  // Update bug status during investigation/fix process
  server.registerTool(
    "update_bug_status",
    {
      description: "Update the status of a bug during investigation or resolution. Use this to mark bugs as investigating, fixing, verifying, resolved, or closed.",
      inputSchema: {
        bug_id: z.string().describe("ID of the bug to update"),
        status: z.enum(["open", "investigating", "fixing", "verifying", "resolved", "closed"]).describe("New status for the bug"),
        resolution: z.string().optional().describe("Resolution details if marking as resolved"),
        assignee_arm_id: z.string().optional().describe("Assign this bug to a specific arm"),
      },
    },
    async ({ bug_id, status, resolution, assignee_arm_id }) => {
      const database = getDatabase();

      try {
        // Get current bug
        const existingBug = database.query("SELECT * FROM bugs WHERE id = ?").get(bug_id) as any;
        if (!existingBug) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Bug ${bug_id} not found.`,
              },
            ],
          };
        }

        const now = new Date().toISOString();
        const updates: string[] = [];
        const params: any[] = [];

        if (status !== existingBug.status) {
          updates.push("status = ?");
          params.push(status);
        }

        if (resolution && resolution !== existingBug.resolution) {
          updates.push("resolution = ?");
          params.push(resolution);
        }

        if (assignee_arm_id && assignee_arm_id !== existingBug.assignee_arm_id) {
          updates.push("assignee_arm_id = ?");
          params.push(assignee_arm_id);
        }

        if (status === "resolved" || status === "closed") {
          updates.push("resolved_at = ?");
          params.push(now);
        }

        updates.push("updated_at = ?");
        params.push(now);

        if (updates.length > 1) { // More than just updated_at
          const result = database.run(`UPDATE bugs SET ${updates.join(", ")} WHERE id = ?`, [...params, bug_id]);

          if (result.changes > 0) {
            // Broadcast update
            broadcast("bugs", "bug.updated", { bugId: bug_id, updates: { status, resolution, assigneeArmId: assignee_arm_id } });

            logActivity(ARM_ID, "update_bug_status", bug_id, {
              status,
              resolution: resolution ? "provided" : undefined,
              assignee: assignee_arm_id,
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Bug ${bug_id} updated: status=${status}${resolution ? `, resolution provided` : ''}${assignee_arm_id ? `, assigned to ${assignee_arm_id}` : ''}`,
                },
              ],
            };
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `No changes needed for bug ${bug_id}.`,
            },
          ],
        };
      } catch (err) {
        console.error(`[MCP] Error updating bug ${bug_id}:`, err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to update bug ${bug_id}: ${err}`,
            },
          ],
        };
      }
    }
  );

  // Assign bug to an arm for investigation/fix
  server.registerTool(
    "assign_bug",
    {
      description: "Assign a bug to a specific arm for investigation or fixing. Use this when you need to delegate bug handling to another arm.",
      inputSchema: {
        bug_id: z.string().describe("ID of the bug to assign"),
        assignee_arm_id: z.string().describe("ID of the arm to assign this bug to"),
        reason: z.string().optional().describe("Reason for this assignment"),
      },
    },
    async ({ bug_id, assignee_arm_id, reason }) => {
      const database = getDatabase();

      try {
        // Verify bug exists
        const bug = database.query("SELECT title FROM bugs WHERE id = ?").get(bug_id) as any;
        if (!bug) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Bug ${bug_id} not found.`,
              },
            ],
          };
        }

        // Update assignee
        const now = new Date().toISOString();
        const result = database.run(
          "UPDATE bugs SET assignee_arm_id = ?, updated_at = ? WHERE id = ?",
          [assignee_arm_id, now, bug_id]
        );

        if (result.changes > 0) {
          // Broadcast update
          broadcast("bugs", "bug.updated", { bugId: bug_id, updates: { assigneeArmId: assignee_arm_id } });

          logActivity(ARM_ID, "assign_bug", bug_id, {
            assignee: assignee_arm_id,
            reason,
          });

          // Send notification to assigned arm
          await sendToBrain({
            from: ARM_ID,
            to: assignee_arm_id,
            type: "bug_assignment",
            payload: {
              bugId: bug_id,
              title: bug.title,
              assignedBy: ARM_ID,
              reason: reason || "Bug investigation required",
            },
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `Bug "${bug.title}" assigned to arm ${assignee_arm_id}.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Bug ${bug_id} is already assigned to ${assignee_arm_id}.`,
            },
          ],
        };
      } catch (err) {
        console.error(`[MCP] Error assigning bug ${bug_id}:`, err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to assign bug ${bug_id}: ${err}`,
            },
          ],
        };
      }
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
      // Auto-register manual arms on first call
      ensureArmRegistered();
      
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
      // Auto-register manual arms
      ensureArmRegistered();
      
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
      // Auto-register manual arms - heartbeat is a natural registration point
      ensureArmRegistered();
      
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
  // CONTEXT COMPRESSION TOOLS - Phase 2.7
  // ============================================

  // Report context compression event
  server.registerTool(
    "report_context_compression",
    {
      description: "Report when your context has been compressed due to budget limits. The brain tracks context usage across all arms to optimize resource allocation.",
      inputSchema: {
        task_id: z.string().describe("The ID of the task being worked on"),
        original_tokens: z.number().describe("Original context token count before compression"),
        compressed_tokens: z.number().describe("Token count after compression"),
        compression_ratio: z.number().describe("Compression ratio (compressed/original, e.g., 0.5 means 50% reduction)"),
        what_was_removed: z.array(z.object({
          type: z.enum(["history", "artifacts", "notes", "tools", "context"]).describe("Type of content removed"),
          description: z.string().describe("Brief description of what was removed"),
          token_count: z.number().describe("Estimated tokens removed"),
        })).describe("Details about what content was removed"),
        work_in_progress: z.string().optional().describe("Brief summary of your current work to reinforce after compression"),
      },
    },
    async ({ task_id, original_tokens, compressed_tokens, compression_ratio, what_was_removed, work_in_progress }) => {
      try {
        const database = getDatabase(false);
        const now = new Date().toISOString();

        database.run(
          `INSERT INTO context_compressions
           (arm_id, task_id, original_tokens, compressed_tokens, compression_ratio,
            removed_content, work_in_progress, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ARM_ID,
            task_id,
            original_tokens,
            compressed_tokens,
            compression_ratio,
            JSON.stringify(what_was_removed),
            work_in_progress || null,
            now,
          ]
        );

        const estimatedCost = original_tokens * 0.01;
        database.run(
          `UPDATE arms SET context_budget_used = context_budget_used + ? WHERE id = ?`,
          [estimatedCost, ARM_ID]
        );

        logActivity(ARM_ID, "context_compression", task_id, {
          original_tokens,
          compressed_tokens,
          compression_ratio,
          estimated_cost: estimatedCost,
          removed_items: what_was_removed.length,
        });

        database.close();
      } catch {
        // Database not available
      }

      const messageId = await sendToBrain({
        from: ARM_ID,
        to: "brain",
        type: "context_compression",
        payload: {
          taskId: task_id,
          originalTokens: original_tokens,
          compressedTokens: compressed_tokens,
          compressionRatio: compression_ratio,
          removedContent: what_was_removed,
          workInProgress: work_in_progress,
          timestamp: new Date().toISOString(),
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Context compression reported: ${original_tokens} → ${compressed_tokens} tokens (${(compression_ratio * 100).toFixed(1)}% remaining)${work_in_progress ? `\n\nCurrent work reinforced: ${work_in_progress}` : ""}\n\nBrain will adjust context budget allocation (message: ${messageId}).`,
          },
        ],
      };
    }
  );

  // Get context budget status
  server.registerTool(
    "get_context_budget",
    {
      description: "Check your current context budget and usage. This helps you understand how much context you have remaining before compression will occur.",
      inputSchema: {
        task_id: z.string().optional().describe("Optional task ID to check specific budget for"),
      },
    },
    async ({ task_id }) => {
      try {
        const database = getDatabase();

        let armBudget = database.query(
          "SELECT context_budget_total, context_budget_used FROM arms WHERE id = ?"
        ).get(ARM_ID) as { context_budget_total: number; context_budget_used: number } | null;

        if (!armBudget) {
          armBudget = { context_budget_total: 128000, context_budget_used: 0 };
        }

        const remaining = armBudget.context_budget_total - armBudget.context_budget_used;
        const usagePercent = (armBudget.context_budget_used / armBudget.context_budget_total) * 100;

        const recentCompressions = database.query(
          `SELECT timestamp, original_tokens, compressed_tokens, compression_ratio
           FROM context_compressions
           WHERE arm_id = ? AND timestamp > datetime('now', '-1 hour')
           ORDER BY timestamp DESC
           LIMIT 10`
        ).all(ARM_ID) as Array<{
          timestamp: string;
          original_tokens: number;
          compressed_tokens: number;
          compression_ratio: number;
        }>;

        database.close();

        const compressionCount = recentCompressions.length;
        const avgCompression = compressionCount > 0
          ? (recentCompressions.reduce((sum, c) => sum + c.compression_ratio, 0) / compressionCount * 100).toFixed(1)
          : "N/A";

        let statusEmoji = "✅";
        if (usagePercent > 80) statusEmoji = "⚠️";
        if (usagePercent > 95) statusEmoji = "🔥";

        return {
          content: [
            {
              type: "text" as const,
              text: `# Context Budget Status\n\n` +
                    `${statusEmoji} **${ARM_ID}**\n\n` +
                    `**Budget:** ${(armBudget.context_budget_total / 1000).toFixed(0)}K tokens\n` +
                    `**Used:** ${(armBudget.context_budget_used / 1000).toFixed(1)}K tokens (${usagePercent.toFixed(1)}%)\n` +
                    `**Remaining:** ${(remaining / 1000).toFixed(1)}K tokens\n\n` +
                    `**Recent compressions (1h):** ${compressionCount}\n` +
                    `**Avg compression:** ${avgCompression}%\n\n` +
                    `**Thresholds:**\n` +
                    `- 80%: Warning - consider completing or compressing\n` +
                    `- 95%: Hard limit - compression will trigger\n` +
                    `- 100%: Maximum - forced compression or task handoff${task_id ? `\n\nTask-specific budget check for: ${task_id}` : ""}`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get context budget: ${errorMsg}`,
            },
          ],
        };
      }
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
          await checkAndEscalateIfThrashing(database, file_path);
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
  // DEV SERVER MANAGEMENT TOOLS
  // ============================================

  // Global dev server monitoring state
  const monitoredServers = new Map<string, {
    process: any;
    logs: string[];
    maxLogs: number;
    startTime: Date;
    status: 'running' | 'stopped' | 'error';
    framework: string;
  }>();

  // Helper function to detect development server framework
  function detectDevServerFramework(command: string): string {
    if (command.includes('vite')) return 'vite';
    if (command.includes('next')) return 'next.js';
    if (command.includes('bun') && command.includes('dev')) return 'bun';
    if (command.includes('npm') && command.includes('dev')) return 'npm/node';
    if (command.includes('yarn') && command.includes('dev')) return 'yarn';
    return 'unknown';
  }

  // Helper function to find running dev server processes
  async function findDevServerProcesses(): Promise<Array<{pid: number, command: string, framework: string}>> {
    try {
      const { spawn } = await import('child_process');
      const { promisify } = await import('util');
      
      return new Promise((resolve) => {
        const ps = spawn('ps', ['aux']);
        let output = '';
        
        ps.stdout.on('data', (data) => {
          output += data.toString();
        });
        
        ps.on('close', () => {
          const lines = output.split('\n');
          const servers: Array<{pid: number, command: string, framework: string}> = [];
          
          for (const line of lines) {
            if (line.includes('vite') || 
                line.includes('next') || 
                (line.includes('bun') && line.includes('dev')) ||
                (line.includes('npm') && line.includes('dev')) ||
                (line.includes('yarn') && line.includes('dev'))) {
              
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2 && parts[1]) {
                const pid = parseInt(parts[1]);
                const command = parts.slice(10).join(' ');
                const framework = detectDevServerFramework(command);
                
                if (!isNaN(pid)) {
                  servers.push({ pid, command, framework });
                }
              }
            }
          }
          
          resolve(servers);
        });
      });
    } catch (err) {
      console.error('Error finding dev server processes:', err);
      return [];
    }
  }

  // Monitor a development server process
  server.registerTool(
    "monitor_dev_server",
    {
      description: "Start monitoring a development server process for logs and status. Use this to track Vite, Next.js, Bun, or other dev servers.",
      inputSchema: {
        server_id: z.string().describe("Unique identifier for this dev server (e.g., 'web-frontend', 'api-server')"),
        pid: z.number().optional().describe("Process ID to monitor (if not provided, will auto-detect)"),
        command: z.string().optional().describe("Command that started the server (for reference)"),
        max_logs: z.number().default(1000).describe("Maximum number of log lines to keep in memory"),
      },
    },
    async ({ server_id, pid, command, max_logs = 1000 }) => {
      try {
        // If no PID provided, try to auto-detect
        if (!pid) {
          const processes = await findDevServerProcesses();
          if (processes.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: "No development server processes found running. Please start a dev server first or provide a specific PID."
              }],
            };
          }
          
          // Use the first detected process if only one, otherwise list options
          if (processes.length === 1) {
            const firstProcess = processes[0];
            if (firstProcess) {
              pid = firstProcess.pid;
              command = command || firstProcess.command;
            }
          } else {
            const processList = processes.map(p => `  PID ${p.pid}: ${p.framework} - ${p.command}`).join('\n');
            return {
              content: [{
                type: "text" as const,
                text: `Multiple dev servers found. Please specify a PID:\n\n${processList}\n\nCall this tool again with the specific pid parameter.`
              }],
            };
          }
        }

        const framework = command ? detectDevServerFramework(command) : 'unknown';
        
        // Ensure we have a valid PID at this point
        if (!pid) {
          return {
            content: [{
              type: "text" as const,
              text: "Unable to determine process ID. Please provide a specific PID."
            }],
          };
        }
        
        // Initialize monitoring state
        monitoredServers.set(server_id, {
          process: { pid },
          logs: [],
          maxLogs: max_logs,
          startTime: new Date(),
          status: 'running',
          framework,
        });

        // Log the monitoring start
        logActivity(ARM_ID, 'monitor_dev_server', server_id, { pid, framework, command });

        return {
          content: [{
            type: "text" as const,
            text: `Started monitoring dev server '${server_id}'\n\n` +
                  `PID: ${pid}\n` +
                  `Framework: ${framework}\n` +
                  `Command: ${command || 'N/A'}\n` +
                  `Max logs: ${max_logs}\n\n` +
                  `Use 'get_dev_server_logs' to retrieve logs and 'get_dev_server_status' to check status.`
          }],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: `Failed to start monitoring: ${errorMsg}`
          }],
        };
      }
    }
  );

  // Get development server logs
  server.registerTool(
    "get_dev_server_logs",
    {
      description: "Retrieve recent logs from a monitored development server. This provides real-time access to dev server output.",
      inputSchema: {
        server_id: z.string().describe("Server identifier from monitor_dev_server"),
        tail_lines: z.number().default(50).describe("Number of recent log lines to retrieve"),
        filter: z.string().optional().describe("Optional filter string to search for in logs"),
      },
    },
    async ({ server_id, tail_lines = 50, filter }) => {
      try {
        const serverInfo = monitoredServers.get(server_id);
        if (!serverInfo) {
          return {
            content: [{
              type: "text" as const,
              text: `Dev server '${server_id}' is not being monitored. Use 'monitor_dev_server' first.`
            }],
          };
        }

        // For now, we'll read logs from the process stdout/stderr
        // In a real implementation, we'd capture the actual process output
        const { spawn } = await import('child_process');
        
        // Get recent logs using journalctl or system logs for the PID
        const logCmd = spawn('ps', ['-p', serverInfo.process.pid.toString(), '-o', 'pid,ppid,cmd']);
        let processInfo = '';
        
        logCmd.stdout.on('data', (data) => {
          processInfo += data.toString();
        });
        
        await new Promise((resolve) => {
          logCmd.on('close', resolve);
        });

        if (!processInfo.includes(serverInfo.process.pid.toString())) {
          serverInfo.status = 'stopped';
          return {
            content: [{
              type: "text" as const,
              text: `Dev server '${server_id}' (PID ${serverInfo.process.pid}) is no longer running.\n\n` +
                    `Status: ${serverInfo.status}\n` +
                    `Framework: ${serverInfo.framework}\n` +
                    `Started: ${serverInfo.startTime.toISOString()}`
            }],
          };
        }

        // For demonstration, return the server status and some mock logs
        // In production, this would capture actual process output
        const mockLogs = [
          `[${new Date().toISOString()}] Dev server running on PID ${serverInfo.process.pid}`,
          `[${new Date().toISOString()}] Framework: ${serverInfo.framework}`,
          `[${new Date().toISOString()}] Status: ${serverInfo.status}`,
          `[${new Date().toISOString()}] Monitoring since: ${serverInfo.startTime.toISOString()}`,
        ];

        let logs = mockLogs.slice(-tail_lines);
        
        if (filter) {
          logs = logs.filter(log => log.toLowerCase().includes(filter.toLowerCase()));
        }

        return {
          content: [{
            type: "text" as const,
            text: `Recent logs for dev server '${server_id}' (${logs.length} lines):\n\n` +
                  logs.join('\n') + '\n\n' +
                  `Note: Full log capture implementation in progress. ` +
                  `Currently showing process status and basic monitoring info.`
          }],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: `Failed to get logs for '${server_id}': ${errorMsg}`
          }],
        };
      }
    }
  );

  // Get development server status
  server.registerTool(
    "get_dev_server_status",
    {
      description: "Check the health and status of monitored development servers.",
      inputSchema: {
        server_id: z.string().optional().describe("Specific server ID to check (if omitted, shows all monitored servers)"),
      },
    },
    async ({ server_id }) => {
      try {
        if (server_id) {
          const serverInfo = monitoredServers.get(server_id);
          if (!serverInfo) {
            return {
              content: [{
                type: "text" as const,
                text: `Dev server '${server_id}' is not being monitored.`
              }],
            };
          }

          // Check if process is still running
          try {
            const { spawn } = await import('child_process');
            const checkCmd = spawn('ps', ['-p', serverInfo.process.pid.toString()]);
            
            await new Promise((resolve, reject) => {
              checkCmd.on('close', (code) => {
                if (code === 0) {
                  serverInfo.status = 'running';
                } else {
                  serverInfo.status = 'stopped';
                }
                resolve(code);
              });
              checkCmd.on('error', reject);
            });
          } catch {
            serverInfo.status = 'error';
          }

          const uptime = new Date().getTime() - serverInfo.startTime.getTime();
          const uptimeStr = Math.floor(uptime / 1000 / 60); // minutes

          return {
            content: [{
              type: "text" as const,
              text: `Status for dev server '${server_id}':\n\n` +
                    `PID: ${serverInfo.process.pid}\n` +
                    `Status: ${serverInfo.status}\n` +
                    `Framework: ${serverInfo.framework}\n` +
                    `Started: ${serverInfo.startTime.toISOString()}\n` +
                    `Uptime: ${uptimeStr} minutes\n` +
                    `Logs cached: ${serverInfo.logs.length}/${serverInfo.maxLogs}`
            }],
          };
        } else {
          // Show all monitored servers
          if (monitoredServers.size === 0) {
            return {
              content: [{
                type: "text" as const,
                text: "No development servers are currently being monitored.\n\nUse 'monitor_dev_server' to start monitoring."
              }],
            };
          }

          const statusList: string[] = [];
          for (const [id, info] of monitoredServers.entries()) {
            const uptime = Math.floor((new Date().getTime() - info.startTime.getTime()) / 1000 / 60);
            statusList.push(`${id}: ${info.status} (${info.framework}, PID ${info.process.pid}, ${uptime}m)`);
          }

          return {
            content: [{
              type: "text" as const,
              text: `Monitored development servers (${monitoredServers.size}):\n\n` +
                    statusList.join('\n') + '\n\n' +
                    `Use 'get_dev_server_status' with server_id for detailed info.`
            }],
          };
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: `Failed to get status: ${errorMsg}`
          }],
        };
      }
    }
  );

  // Request development server restart (requires brain coordination)
  server.registerTool(
    "restart_dev_server",
    {
      description: "Request a development server restart. This is a destructive operation that goes through the brain for coordination with other arms.",
      inputSchema: {
        server_id: z.string().describe("Server identifier to restart"),
        reason: z.string().describe("Reason for requesting restart (e.g., 'config changes', 'dependency updates')"),
        force: z.boolean().default(false).describe("Force restart even if files are claimed by other arms"),
      },
    },
    async ({ server_id, reason, force = false }) => {
      try {
        const serverInfo = monitoredServers.get(server_id);
        if (!serverInfo) {
          return {
            content: [{
              type: "text" as const,
              text: `Dev server '${server_id}' is not being monitored. Use 'monitor_dev_server' first.`
            }],
          };
        }

        // Send restart request to brain for coordination
        const messageId = await sendToBrain({
          from: ARM_ID,
          to: "brain",
          type: "dev_server_restart_request",
          payload: {
            serverId: server_id,
            pid: serverInfo.process.pid,
            framework: serverInfo.framework,
            reason,
            force,
            requestedAt: new Date().toISOString(),
            requestedBy: ARM_ID,
          },
        });

        // Log the restart request
        logActivity(ARM_ID, 'request_dev_server_restart', server_id, { 
          reason, 
          force, 
          pid: serverInfo.process.pid,
          messageId 
        });

        return {
          content: [{
            type: "text" as const,
            text: `Restart request sent to brain for dev server '${server_id}'\n\n` +
                  `PID: ${serverInfo.process.pid}\n` +
                  `Framework: ${serverInfo.framework}\n` +
                  `Reason: ${reason}\n` +
                  `Force: ${force}\n` +
                  `Request ID: ${messageId}\n\n` +
                  `The brain will coordinate with other arms and check file claims before proceeding. ` +
                  `You will be notified of the decision on your next poll cycle.`
          }],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: `Failed to request restart for '${server_id}': ${errorMsg}`
          }],
        };
      }
    }
  );

  // Stop monitoring a development server
  server.registerTool(
    "stop_monitoring_dev_server",
    {
      description: "Stop monitoring a development server. This only stops the monitoring, it does not stop the server process.",
      inputSchema: {
        server_id: z.string().describe("Server identifier to stop monitoring"),
      },
    },
    async ({ server_id }) => {
      try {
        const serverInfo = monitoredServers.get(server_id);
        if (!serverInfo) {
          return {
            content: [{
              type: "text" as const,
              text: `Dev server '${server_id}' is not being monitored.`
            }],
          };
        }

        // Remove from monitoring
        monitoredServers.delete(server_id);

        // Log the stop monitoring action
        logActivity(ARM_ID, 'stop_monitoring_dev_server', server_id, { 
          pid: serverInfo.process.pid,
          framework: serverInfo.framework 
        });

        return {
          content: [{
            type: "text" as const,
            text: `Stopped monitoring dev server '${server_id}'\n\n` +
                  `PID: ${serverInfo.process.pid}\n` +
                  `Framework: ${serverInfo.framework}\n\n` +
                  `The server process is still running. This only stopped the monitoring.`
          }],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: `Failed to stop monitoring '${server_id}': ${errorMsg}`
          }],
        };
      }
    }
  );

  // ============================================
  // BRAIN INTELLIGENCE TOOLS - Rich context from the brain
  // ============================================

  // Get task determination (what should the brain decide to work on next?)
  server.registerTool(
    "get_task_determination",
    {
      description: "Get the brain's task determination - what task should be worked on next based on the plan, completed tasks, and open discoveries. This uses the same logic as 'octopai brain prompt:task' CLI command.",
      inputSchema: {},
    },
    async () => {
      // Auto-register manual arms
      ensureArmRegistered();
      
      try {
        // Use writable database - generateTaskDetermination may create tasks from plan
        const database = getDatabase(false);
        
        const ctx: PromptContext = {
          projectRoot: PROJECT_ROOT,
          coleoDir: COLEO_DIR,
          db: database,
        };
        
        const result = await generateTaskDetermination(ctx);
        const formatted = formatTaskDetermination(result);
        
        logActivity(ARM_ID, "get_task_determination", result.task?.id, {
          hasTask: !!result.task,
          taskSubject: result.task?.subject,
          reasoning: result.reasoning,
        });
        
        return {
          content: [
            {
              type: "text" as const,
              text: formatted,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get task determination: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // Get context bundle for a specific task
  server.registerTool(
    "get_context_bundle",
    {
      description: "Get the full context bundle for a specific task, including discoveries, plan excerpt, task history, and instructions. This uses the same logic as 'octopai brain prompt:context' CLI command.",
      inputSchema: {
        task_subject: z.string().describe("The task subject or ID to get context for"),
      },
    },
    async ({ task_subject }) => {
      try {
        const database = getDatabase();
        
        const ctx: PromptContext = {
          projectRoot: PROJECT_ROOT,
          coleoDir: COLEO_DIR,
          db: database,
        };
        
        const result = await generateContextBundle(ctx, task_subject);
        
        if (!result) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No task found matching: ${task_subject}\n\nTry using 'get_my_instructions' to see available tasks, or 'get_task_determination' to get the brain's recommended next task.`,
              },
            ],
          };
        }
        
        const formatted = formatContextBundle(result);
        
        logActivity(ARM_ID, "get_context_bundle", result.task.subject, {
          taskSubject: result.task.subject,
          priority: result.task.priority,
          classification: result.task.classification,
        });
        
        return {
          content: [
            {
              type: "text" as const,
              text: formatted,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get context bundle: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // Get full briefing (task determination + context bundle in one call)
  server.registerTool(
    "get_full_briefing",
    {
      description: "Get a complete briefing: the brain's task determination AND the full context bundle for that task. This is the recommended way to start work - it combines 'get_task_determination' and 'get_context_bundle' into a single call for efficiency. After reviewing the briefing, use 'claim_task' to claim ownership of the task.",
      inputSchema: {},
    },
    async () => {
      console.error(`[MCP] get_full_briefing called by ${ARM_ID}`);
      // Auto-register manual arms - this is the recommended entry point
      ensureArmRegistered();
      
      try {
        // Use writable database - generateTaskDetermination may create tasks from plan
        const database = getDatabase(false);
        
        const ctx: PromptContext = {
          projectRoot: PROJECT_ROOT,
          coleoDir: COLEO_DIR,
          db: database,
        };
        
        // Step 1: Get task determination
        const determination = await generateTaskDetermination(ctx);
        const determinationFormatted = formatTaskDetermination(determination);
        
        if (!determination.task) {
          logActivity(ARM_ID, "get_full_briefing", undefined, {
            hasTask: false,
            reasoning: determination.reasoning,
          });
          
          return {
            content: [
              {
                type: "text" as const,
                text: determinationFormatted + "\n\n---\n\nNo task was determined, so no context bundle is available.",
              },
            ],
          };
        }
        
        // Step 2: Get context bundle for the determined task
        const contextBundle = await generateContextBundle(ctx, determination.task.subject);
        
        let fullBriefing = determinationFormatted;
        
        if (contextBundle) {
          const contextFormatted = formatContextBundle(contextBundle);
          fullBriefing += "\n" + "=".repeat(60) + "\n\n" + contextFormatted;
        } else {
          fullBriefing += "\n---\n\n*Context bundle could not be generated for this task.*";
        }
        
        logActivity(ARM_ID, "get_full_briefing", determination.task.id, {
          hasTask: true,
          taskSubject: determination.task.subject,
          taskId: determination.task.id,
          priority: determination.task.priority,
          hasContextBundle: !!contextBundle,
        });
        
        return {
          content: [
            {
              type: "text" as const,
              text: fullBriefing,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get full briefing: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // Get recent events for this arm
  server.registerTool(
    "get_arm_events",
    {
      description: "Get recent events from this arm's OpenCode session. Events include session compaction, message updates, tool invocations, and other session activity. Use this to monitor session state and detect important changes.",
      inputSchema: {
        limit: z.number().optional().describe("Maximum number of events to return (default: 20, max: 100)"),
        since: z.string().optional().describe("Only return events after this ISO timestamp"),
        event_type: z.string().optional().describe("Filter by specific event type (e.g., 'session.compacted', 'message.updated')"),
      },
    },
    async ({ limit = 20, since, event_type }) => {
      console.error(`[MCP] get_arm_events called by ${ARM_ID} (limit: ${limit}, since: ${since}, type: ${event_type})`);

      try {
        // Query the main server for stored events
        const apiUrl = process.env.COLEO_API_URL || "http://127.0.0.1:8080";
        const params = new URLSearchParams();
        params.set("limit", Math.min(limit, 100).toString());
        if (since) params.set("since", since);
        if (event_type) params.set("type", event_type);

        const response = await fetch(`${apiUrl}/api/arms/${ARM_ID}/stored-events?${params}`, {
          headers: {
            "Authorization": `Bearer ${process.env.COLEO_API_KEY || "dev-api-key-12345"}`,
          },
        });

        if (!response.ok) {
          throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as {
          armId: string;
          events: Array<{ type: string; data: unknown; timestamp: string }>;
          count: number;
        };

        if (!data.events || data.events.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No events found for arm ${ARM_ID}${event_type ? ` of type "${event_type}"` : ""}${since ? ` since ${since}` : ""}.`,
              },
            ],
          };
        }

        // Format events for display
        const eventSummary = data.events.map((event) =>
          `- **${event.timestamp}** | ${event.type}: ${JSON.stringify(event.data, null, 2).slice(0, 200)}${JSON.stringify(event.data, null, 2).length > 200 ? "..." : ""}`
        ).join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `# Recent Events for Arm ${ARM_ID}\n\nFound ${data.events.length} events:\n\n${eventSummary}`,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[MCP] get_arm_events failed: ${errorMsg}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to retrieve arm events: ${errorMsg}`,
            },
          ],
        };
      }
    }
  );

  // ============================================
  // SERVICE MANAGEMENT TOOLS
  // These tools require COLEO_SELF_MODIFY=1 env var
  // Only available to arms working on Coleo itself
  // ============================================

  // Get service status
  server.registerTool(
    "service_status",
    {
      description: "Get the status of Coleo services (server, brain). Always available.",
      inputSchema: {
        service: z.enum(["server", "brain", "all"]).describe("Which service to check"),
      },
    },
    async ({ service }) => {
      try {
        if (service === "all") {
          const [serverStatus, brainStatus] = await Promise.all([
            getServiceStatus("server"),
            getServiceStatus("brain"),
          ]);
          
          const formatStatus = (s: typeof serverStatus) => {
            if (s.running) {
              return `${s.type}: RUNNING (PID: ${s.pid}, uptime: ${formatUptime(s.uptime || 0)})`;
            }
            return `${s.type}: STOPPED`;
          };
          
          return {
            content: [
              {
                type: "text" as const,
                text: `Service Status:\n  ${formatStatus(serverStatus)}\n  ${formatStatus(brainStatus)}`,
              },
            ],
          };
        }
        
        const status = await getServiceStatus(service as ServiceType);
        
        if (status.running) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${service}: RUNNING\n  PID: ${status.pid}\n  Started: ${status.startedAt}\n  Uptime: ${formatUptime(status.uptime || 0)}`,
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text" as const,
              text: `${service}: STOPPED`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking service status: ${err}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Restart a service (requires COLEO_SELF_MODIFY=1)
  server.registerTool(
    "service_restart",
    {
      description: 
        "Restart a Coleo service (server or brain). " +
        "REQUIRES COLEO_SELF_MODIFY=1 environment variable. " +
        "Only use this when working on Coleo code itself and need to apply changes.",
      inputSchema: {
        service: z.enum(["server", "brain"]).describe("Which service to restart"),
        force: z.boolean().optional().describe("Force kill if graceful shutdown fails"),
      },
    },
    async ({ service, force }) => {
      // Check permission first
      if (!isSelfModifyAllowed()) {
        return {
          content: [
            {
              type: "text" as const,
              text: 
                "ERROR: Service restart requires COLEO_SELF_MODIFY=1 environment variable.\n\n" +
                "This tool is only available to arms that are working on the Coleo codebase itself. " +
                "The environment variable acts as a safety guard to prevent accidental service restarts.",
            },
          ],
          isError: true,
        };
      }
      
      try {
        console.error(`[MCP] service_restart called by ${ARM_ID} for ${service}`);
        logActivity(ARM_ID, "service_restart", service, { force });
        
        const status = await restartService(service as ServiceType, {
          force: force ?? false,
          timeout: 5000,
        });
        
        if (status.running) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${service} restarted successfully.\n  PID: ${status.pid}\n  Started: ${status.startedAt}`,
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to restart ${service}. Service is not running after restart attempt.`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error restarting ${service}: ${err}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Stop a service (requires COLEO_SELF_MODIFY=1)
  server.registerTool(
    "service_stop",
    {
      description: 
        "Stop a Coleo service (server or brain). " +
        "REQUIRES COLEO_SELF_MODIFY=1 environment variable. " +
        "Use with caution - stopping the server will disconnect this arm!",
      inputSchema: {
        service: z.enum(["server", "brain"]).describe("Which service to stop"),
        force: z.boolean().optional().describe("Force kill if graceful shutdown fails"),
      },
    },
    async ({ service, force }) => {
      // Check permission first
      if (!isSelfModifyAllowed()) {
        return {
          content: [
            {
              type: "text" as const,
              text: 
                "ERROR: Service stop requires COLEO_SELF_MODIFY=1 environment variable.\n\n" +
                "This tool is only available to arms that are working on the Coleo codebase itself.",
            },
          ],
          isError: true,
        };
      }
      
      // Warn about stopping the server
      if (service === "server") {
        console.error(`[MCP] WARNING: ${ARM_ID} is stopping the server - this arm will lose connection!`);
      }
      
      try {
        console.error(`[MCP] service_stop called by ${ARM_ID} for ${service}`);
        logActivity(ARM_ID, "service_stop", service, { force });
        
        const status = await stopService(service as ServiceType, {
          force: force ?? false,
          timeout: 5000,
        });
        
        if (!status.running) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${service} stopped successfully.`,
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to stop ${service}. Service is still running (PID: ${status.pid}).`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error stopping ${service}: ${err}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Start a service (requires COLEO_SELF_MODIFY=1)
  server.registerTool(
    "service_start",
    {
      description: 
        "Start a Coleo service (server or brain). " +
        "REQUIRES COLEO_SELF_MODIFY=1 environment variable.",
      inputSchema: {
        service: z.enum(["server", "brain"]).describe("Which service to start"),
      },
    },
    async ({ service }) => {
      // Check permission first
      if (!isSelfModifyAllowed()) {
        return {
          content: [
            {
              type: "text" as const,
              text: 
                "ERROR: Service start requires COLEO_SELF_MODIFY=1 environment variable.\n\n" +
                "This tool is only available to arms that are working on the Coleo codebase itself.",
            },
          ],
          isError: true,
        };
      }
      
      try {
        console.error(`[MCP] service_start called by ${ARM_ID} for ${service}`);
        logActivity(ARM_ID, "service_start", service, {});
        
        const status = await startService(service as ServiceType);
        
        if (status.running) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${service} started successfully.\n  PID: ${status.pid}\n  Started: ${status.startedAt}`,
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to start ${service}.`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error starting ${service}: ${err}`,
            },
          ],
          isError: true,
        };
      }
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
            uri: "coleo://notes/shared",
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
    "coleo://status",
    {},
    async () => {
      const stateFile = join(COLEO_DIR, "state", "brain.json");
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
            uri: "coleo://status",
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
 * Run the MCP server (called when invoked as `coleo mcp serve`)
 */
export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

   console.error(`[coleo] MCP server started for arm: ${ARM_ID}`);
}
