/**
 * MCP Server for Octopai Brain
 *
 * Exposes tools and resources that tentacles can use to:
 * - Claim and complete tasks
 * - Report discoveries
 * - Request approvals
 * - Share notes with other tentacles
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Task, Discovery, Note, QueueMessage } from "../types";
import { writeFile, readFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";

// Get octopai directory from env or default
const OCTOPAI_DIR = process.env.OCTOPAI_DIR || join(process.env.HOME || "~", ".octopai");
const TENTACLE_ID = process.env.OCTOPAI_TENTACLE_ID || "unknown";

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

// TODO : The tentacles need a way of recognizing when they're in conflict with each other, when one is attempting to make changes to the same file that the other one is. So when it notices that a file is changed since the agent last worked on it unexpectedly, then it It should be able to send that information up to the brain and the brain can distribute that information to the rest of the tentacles so that they know that there's a whoever's working on this file. Um this other tentacle is reporting that things are changing out from underneath it. And then the brain should help resolve conflict conflict. So if two tentacles claim a certain file that they're working on currently, then the brain needs to either allow them to work together because they're not going to conflict because they're working out different parts of the code and the brain should say okay tentacle one split the code into these files tentacle two you can do this in this file and this in the other file So it should resolve conflicts and it should uh grant priority to whichever one is most important or it looks like it's most likely to succeed or is doing the most important most important work on that file and then it should notify when those locks are released

/**
 * Read pending tasks for this tentacle
 */
async function getPendingTasks(): Promise<Task[]> {
  const tasksFile = join(OCTOPAI_DIR, "state", "tasks.json");
  try {
    const content = await readFile(tasksFile, "utf-8");
    const tasks: Task[] = JSON.parse(content);
    return tasks.filter(t => t.status === "pending" || (t.status === "claimed" && t.assignedTo === TENTACLE_ID));
  } catch {
    return [];
  }
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
  // TOOLS - Actions tentacles can perform
  // ============================================

  // Claim a task from the queue
  server.registerTool(
    "claim_task",
    {
      description: "Claim a pending task to work on",
      inputSchema: {
        task_id: z.string().describe("The ID of the task to claim"),
      },
      outputSchema: {
        content: z.array(
          z.object({
            type: z.literal("text"),
            text: z.string(),
          })
        ).describe("Response content"),
      },
    },
    async ({ task_id }) => {
      const messageId = await sendToBrain({
        from: TENTACLE_ID,
        to: "brain",
        type: "task_assignment",
        payload: {
          action: "claim",
          taskId: task_id,
        },
      });

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
      outputSchema: {
        content: z.array(
          z.object({
            type: z.literal("text"),
            text: z.string(),
          })
        ).describe("Response content"),
      },
    },
    async ({ task_id, summary, artifacts }) => {
      const messageId = await sendToBrain({
        from: TENTACLE_ID,
        to: "brain",
        type: "task_complete",
        payload: {
          taskId: task_id,
          summary,
          artifacts: artifacts || [],
        },
      });

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
      outputSchema: {
        content: z.array(
          z.object({
            type: z.literal("text"),
            text: z.string(),
          })
        ).describe("Response content"),
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
        from: TENTACLE_ID,
        to: "brain",
        type: "discovery",
        payload: discovery,
      });

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
      outputSchema: {
        content: z.array(
          z.object({
            type: z.literal("text"),
            text: z.string(),
          })
        ).describe("Response content"),
      },
    },
    async ({ action, context, options }) => {
      const messageId = await sendToBrain({
        from: TENTACLE_ID,
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
      description: "Share a learning or insight with other tentacles",
      inputSchema: {
        title: z.string().describe("Title of the note"),
        content: z.string().describe("Content (markdown supported)"),
        tags: z.array(z.string()).describe("Tags for categorization"),
      },
      outputSchema: {
        content: z.array(
          z.object({
            type: z.literal("text"),
            text: z.string(),
          })
        ).describe("Response content"),
      },
    },
    async ({ title, content, tags }) => {
      const note: Omit<Note, "id" | "createdAt" | "updatedAt"> = {
        author: TENTACLE_ID,
        title,
        content,
        tags,
      };

      const messageId = await sendToBrain({
        from: TENTACLE_ID,
        to: "brain",
        type: "share_note",
        payload: note,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Note "${title}" shared (message: ${messageId}). Brain will distribute to relevant tentacles.`,
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
      outputSchema: {
        content: z.array(
          z.object({
            type: z.literal("text"),
            text: z.string(),
          })
        ).describe("Response content"),
      },
    },
    async ({ name, command, description, context }) => {
      const messageId = await sendToBrain({
        from: TENTACLE_ID,
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

  // ============================================
  // RESOURCES - Data tentacles can read
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
    "Shared knowledge base from all tentacles",
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

  console.error(`[octopai] MCP server started for tentacle: ${TENTACLE_ID}`);
}
