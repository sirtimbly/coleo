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
import { getColeoDir } from "../config";
import {
	getCompressionConfigFromEnv,
	getStatusEmoji,
	formatThresholds,
	DEFAULT_COMPRESSION_CONFIG,
	type CompressionConfig,
} from "./config/compression";
import { NatsClient } from "../nats";
import { eventStore } from "../nats/jetstream";
import {
	getPendingMessages,
	markMessageCompleted,
	getNotes,
} from "../db/state";
import { createApiDatabase } from "./api-db";
import { broadcast } from "../api/websocket";
import { registerAllTools } from "./tools";
import { registerResources } from "./resources";
import {
	createCommandEnvelope,
	getMcpCommandPublishMode,
} from "../nats/command-types";
import {
	generateTaskDetermination,
	generateContextBundle,
	formatTaskDetermination,
	formatContextBundle,
	type PromptContext,
	type TaskDeterminationOptions,
	type TaskDeterminationResult,
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
import {
	COLEO_DIR,
	ARM_ID,
	PROJECT_ROOT,
	API_BASE_URL,
	API_KEY,
	rememberRecentlyCompletedTask,
	getRecentCompletedTaskIdForExclusion,
	clearRecentCompletedTaskExclusion,
	buildTaskDeterminationOptionsForArm,
	updateCompletionExclusionAfterDetermination,
	getArmSessionId,
	getDatabase,
	getNatsClient,
	logActivity,
	ensureArmRegistered,
	publishCommandViaApi,
	publishCommandViaNats,
	sendToBrain,
	sendToBrainFile,
	getMyInstructions,
	normalizeReference,
	findTaskByReference,
	findBugByReference,
	getTaskReferenceHint,
	getBugReferenceHint,
	resolveTaskReferenceForTool,
	resolveBugReferenceForTool,
	type TaskReferenceRow,
	type BugReferenceRow,
} from "./utils";
import { VERSION } from "../version";

/**
 * Create and configure the MCP server
 */
export function createMcpServer(): McpServer {
	const server = new McpServer({
		name: "coleo-brain",
		version: VERSION,
	});

	// ============================================
	// TOOLS - Actions arms can perform
	// ============================================

	// Register all tools from modular tool handlers
	registerAllTools(server);

	// Claim a bug to work on
	server.registerTool(
		"claim_bug",
		{
			description: "Claim a pending bug to work on",
			inputSchema: {
				bug_id: z.string().describe("The ID of the bug to claim"),
			},
		},
		async ({ bug_id }) => {
			const resolution = resolveBugReferenceForTool(bug_id);
			if ("error" in resolution) {
				return {
					content: [
						{
							type: "text" as const,
							text: resolution.error,
						},
					],
				};
			}

			const resolvedBugId = resolution.bugId;
			console.error(`[MCP] claim_bug called by ${ARM_ID} for bug ${resolvedBugId}`);
				const messageId = await sendToBrain({
					from: ARM_ID,
					to: "brain",
					type: "bug_claim",
					payload: {
						action: "claim",
						bugId: resolvedBugId,
					},
				});
				clearRecentCompletedTaskExclusion();

			logActivity(ARM_ID, "claim_bug", resolvedBugId, { messageId });
			console.error(`[MCP] claim_bug completed, messageId: ${messageId}`);

			return {
				content: [
					{
						type: "text" as const,
						text: `${resolution.note ? `${resolution.note}\n\n` : ""}Bug ${resolvedBugId} claim request sent (message: ${messageId}). Brain will confirm assignment.`,
					},
				],
			};
		},
	);

	// Request approval from human
	server.registerTool(
		"request_approval",
		{
			description:
				"Ask the human for approval before taking a significant action",
			inputSchema: {
				action: z.string().describe("What you want to do"),
				context: z
					.string()
					.describe("Why this needs approval and any relevant details"),
				options: z
					.array(z.string())
					.optional()
					.describe("Options for the human to choose from"),
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
		},
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

			logActivity(ARM_ID, "share_note", undefined, {
				messageId,
				title,
				tagCount: tags.length,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Note "${title}" shared (message: ${messageId}). Brain will distribute to relevant arms.`,
					},
				],
			};
		},
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
		},
	);

	// ============================================
	// CONTEXT COMPRESSION TOOLS - Phase 2.7
	// ============================================

	// Report context compression event
	server.registerTool(
		"report_context_compression",
		{
			description:
				"Report when your context has been compressed due to budget limits. The brain tracks context usage across all arms to optimize resource allocation.",
			inputSchema: {
				task_id: z.string().describe("The ID of the task being worked on"),
				original_tokens: z
					.number()
					.describe("Original context token count before compression"),
				compressed_tokens: z.number().describe("Token count after compression"),
				compression_ratio: z
					.number()
					.describe(
						"Compression ratio (compressed/original, e.g., 0.5 means 50% reduction)",
					),
				what_was_removed: z
					.array(
						z.object({
							type: z
								.enum(["history", "artifacts", "notes", "tools", "context"])
								.describe("Type of content removed"),
							description: z
								.string()
								.describe("Brief description of what was removed"),
							token_count: z.number().describe("Estimated tokens removed"),
						}),
					)
					.describe("Details about what content was removed"),
				work_in_progress: z
					.string()
					.optional()
					.describe(
						"Brief summary of your current work to reinforce after compression",
					),
			},
		},
		async ({
			task_id,
			original_tokens,
			compressed_tokens,
			compression_ratio,
			what_was_removed,
			work_in_progress,
		}) => {
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
					],
				);

				const estimatedCost = original_tokens * 0.01;
				database.run(
					`UPDATE arms SET context_budget_used = context_budget_used + ? WHERE id = ?`,
					[estimatedCost, ARM_ID],
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
		},
	);

	// Get context budget status
	server.registerTool(
		"get_context_budget",
		{
			description:
				"Check your current context budget and usage. This helps you understand how much context you have remaining before compression will occur.",
			inputSchema: {
				task_id: z
					.string()
					.optional()
					.describe("Optional task ID to check specific budget for"),
			},
		},
		async ({ task_id }) => {
			try {
				const database = getDatabase();

				let armBudget = database
					.query(
						"SELECT context_budget_total, context_budget_used FROM arms WHERE id = ?",
					)
					.get(ARM_ID) as {
					context_budget_total: number;
					context_budget_used: number;
				} | null;

				if (!armBudget) {
					armBudget = { context_budget_total: 300000, context_budget_used: 0 };
				}

				const remaining =
					armBudget.context_budget_total - armBudget.context_budget_used;
				const usagePercent =
					(armBudget.context_budget_used / armBudget.context_budget_total) *
					100;

				const recentCompressions = database
					.query(
						`SELECT timestamp, original_tokens, compressed_tokens, compression_ratio
           FROM context_compressions
           WHERE arm_id = ? AND timestamp > datetime('now', '-1 hour')
           ORDER BY timestamp DESC
           LIMIT 10`,
					)
					.all(ARM_ID) as Array<{
					timestamp: string;
					original_tokens: number;
					compressed_tokens: number;
					compression_ratio: number;
				}>;

				database.close();

				const compressionCount = recentCompressions.length;
				const avgCompression =
					compressionCount > 0
						? (
								(recentCompressions.reduce(
									(sum, c) => sum + c.compression_ratio,
									0,
								) /
									compressionCount) *
								100
							).toFixed(1)
						: "N/A";

				// Load compression configuration from environment (sync for MCP tools)
				const compressionConfig = getCompressionConfigFromEnv();
				const statusEmoji = getStatusEmoji(usagePercent, compressionConfig);

				return {
					content: [
						{
							type: "text" as const,
							text:
								`# Context Budget Status\n\n` +
								`${statusEmoji} **${ARM_ID}**\n\n` +
								`**Budget:** ${(armBudget.context_budget_total / 1000).toFixed(0)}K tokens\n` +
								`**Used:** ${(armBudget.context_budget_used / 1000).toFixed(1)}K tokens (${usagePercent.toFixed(1)}%)\n` +
								`**Remaining:** ${(remaining / 1000).toFixed(1)}K tokens\n\n` +
								`**Recent compressions (1h):** ${compressionCount}\n` +
								`**Avg compression:** ${avgCompression}%\n\n` +
								formatThresholds(compressionConfig) +
								`${task_id ? `\n\nTask-specific budget check for: ${task_id}` : ""}`,
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
		},
	);

	// ============================================
	// ============================================
	// DOCUMENTATION AWARENESS TOOLS - Stay in sync with project docs
	// ============================================

	// Get documentation content
	server.registerTool(
		"get_documentation",
		{
			description:
				"Read documentation content from the docs/ directory. Use this to understand project requirements, plans, and architectural decisions. Always check relevant docs before starting work on a task.",
			inputSchema: {
				path: z
					.string()
					.optional()
					.describe(
						"Relative path from docs/ (e.g., 'architecture/overview.md' or 'plans/phase1.md'). Leave empty to list available docs.",
					),
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
							} else if (
								entry.isFile() &&
								(entry.name.endsWith(".md") || entry.name.endsWith(".txt"))
							) {
								let category: string = "other";
								const parts = relPath.split("/");
								if (parts[0] === "architecture") category = "architecture";
								else if (parts[0] === "guides") category = "guides";
								else if (parts[0] === "plans") category = "plans";
								else if (parts[0] === "requirements") category = "requirements";
								else if (parts[0] === "decisions") category = "decisions";
								(categories as Record<string, string[]>)[category]!.push(
									relPath,
								);
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
						content: [
							{
								type: "text" as const,
								text: "No docs/ directory found. Create docs/ to store project documentation.",
							},
						],
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
					content: [
						{ type: "text" as const, text: `Document not found: docs/${path}` },
					],
				};
			}
		},
	);

	// Check for documentation changes
	server.registerTool(
		"check_documentation_changes",
		{
			description:
				"Check if any documentation has changed since you last read it. Call this periodically or when starting a new task to ensure you're working with current information.",
			inputSchema: {
				since: z
					.string()
					.optional()
					.describe(
						"ISO timestamp to check changes since (default: your session start)",
					),
				category: z
					.enum([
						"architecture",
						"guides",
						"plans",
						"requirements",
						"decisions",
						"all",
					])
					.optional()
					.describe("Only check changes in this category"),
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
						} else if (
							entry.isFile() &&
							(entry.name.endsWith(".md") || entry.name.endsWith(".txt"))
						) {
							// Check if in requested category
							if (category && category !== "all") {
								const docCategory = relPath.split("/")[0];
								if (docCategory !== category) continue;
							}

							const stats = await stat(fullPath);
							if (stats.mtime > checkSince) {
								const content = await readFile(fullPath, "utf-8");
								const hash = createHash("sha256")
									.update(content)
									.digest("hex")
									.slice(0, 16);
								changes.push({ path: relPath, modified: stats.mtime, hash });
							}
						}
					}
				};
				await scanAndCheck(docsDir);
			} catch {
				return {
					content: [
						{ type: "text" as const, text: "Could not scan docs/ directory." },
					],
				};
			}

			if (changes.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No documentation changes detected since your check time.",
						},
					],
				};
			}

			const changeList = changes
				.map((c) => `- docs/${c.path} (modified: ${c.modified.toISOString()})`)
				.join("\n");

			logActivity(ARM_ID, "check_documentation_changes", undefined, {
				changeCount: changes.length,
				category,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `# Documentation Changes\n\n${changeList}\n\n**Recommendation:** Use 'get_documentation' to re-read these files before continuing.`,
					},
				],
			};
		},
	);

	// Find relevant documentation for a task
	server.registerTool(
		"find_relevant_docs",
		{
			description:
				"Find documentation relevant to your current task or work. Provide a description of what you're working on and get recommendations for docs to read.",
			inputSchema: {
				task_description: z
					.string()
					.describe(
						"Description of your current task or what you're working on",
					),
				max_results: z
					.number()
					.optional()
					.describe("Maximum number of docs to return (default: 5)"),
			},
		},
		async ({ task_description, max_results = 5 }) => {
			const keywords = task_description
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 2);
			const docsDir = join(PROJECT_ROOT, "docs");
			const scored: Array<{ path: string; score: number; preview: string }> =
				[];

			try {
				const scanForRelevance = async (dir: string, baseRel: string = "") => {
					const entries = await readdir(dir, { withFileTypes: true });
					for (const entry of entries) {
						const fullPath = join(dir, entry.name);
						const relPath = baseRel ? `${baseRel}/${entry.name}` : entry.name;

						if (entry.isDirectory()) {
							await scanForRelevance(fullPath, relPath);
						} else if (
							entry.isFile() &&
							(entry.name.endsWith(".md") || entry.name.endsWith(".txt"))
						) {
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
								const preview =
									content
										.slice(0, 200)
										.replace(/[#*`\n]/g, " ")
										.trim() + "...";
								scored.push({ path: relPath, score, preview });
							}
						}
					}
				};
				await scanForRelevance(docsDir);
			} catch {
				return {
					content: [
						{ type: "text" as const, text: "Could not scan docs/ directory." },
					],
				};
			}

			scored.sort((a, b) => b.score - a.score);
			const topDocs = scored.slice(0, max_results);

			if (topDocs.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No particularly relevant documentation found. Try using 'get_documentation' to explore the docs/ directory.",
						},
					],
				};
			}

			const docList = topDocs
				.map(
					(d) => `## docs/${d.path}\n**Relevance:** ${d.score}\n\n${d.preview}`,
				)
				.join("\n\n---\n\n");
			return {
				content: [
					{
						type: "text" as const,
						text: `# Relevant Documentation for Your Work\n\n${docList}\n\n---\n\nUse 'get_documentation' to read any of these in full.`,
					},
				],
			};
		},
	);

	// Update documentation
	server.registerTool(
		"update_documentation",
		{
			description:
				"Update a documentation file with new content. Use this when the human has provided feedback that requires updating docs, requirements, or plans. The brain will be notified of the update.",
			inputSchema: {
				path: z
					.string()
					.describe("Relative path from docs/ (e.g., 'requirements/auth.md')"),
				content: z.string().describe("The new content for the document"),
				reason: z
					.string()
					.describe(
						"Brief explanation of why this update is needed (e.g., 'User clarified requirements via email')",
					),
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
					content: [
						{
							type: "text" as const,
							text: `Failed to update docs/${path}: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Subscribe to watch a file or pattern
	server.registerTool(
		"subscribe_file",
		{
			description:
				"Subscribe to changes for a file or glob pattern. You will be notified when the file changes. Use this for documentation and requirements files relevant to your current task.",
			inputSchema: {
				pattern: z
					.string()
					.describe(
						"File path or glob pattern to watch (e.g., 'docs/requirements/*.md' or 'src/api/*.ts')",
					),
				category: z
					.enum([
						"architecture",
						"guides",
						"plans",
						"requirements",
						"decisions",
						"other",
						"source",
					])
					.optional()
					.describe("Category for filtering change notifications"),
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
		},
	);

	// Unsubscribe from a file pattern
	server.registerTool(
		"unsubscribe_file",
		{
			description:
				"Stop watching a file or pattern you previously subscribed to.",
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
		},
	);

	// Report a file change that was detected
	server.registerTool(
		"report_file_change",
		{
			description:
				"Report that you detected a file change. The brain will notify other subscribed arms.",
			inputSchema: {
				file_path: z
					.string()
					.describe("Path to the file that changed (relative to project root)"),
				change_type: z
					.enum(["created", "modified", "deleted"])
					.describe("Type of change"),
				summary: z.string().describe("Brief summary of what changed"),
				impact: z
					.string()
					.optional()
					.describe("Assessment of impact on current work"),
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
		},
	);

	// ============================================
	// SEARCH TOOLS - Brain/arm search access
	// ============================================

	// Search across indexed brain/arm data
	server.registerTool(
		"search",
		{
			description:
				"Search across indexed brain/arm data (tasks, arms, discoveries, etc.).",
			inputSchema: {
				query: z.string().describe("Search query"),
				types: z
					.array(z.string())
					.optional()
					.describe("Search types to include (default: all)"),
				limit: z
					.number()
					.optional()
					.describe("Maximum results to return (default: 20)"),
				offset: z
					.number()
					.optional()
					.describe("Offset for pagination (default: 0)"),
				min_score: z
					.number()
					.optional()
					.describe("Minimum score threshold (default: 0.1)"),
				keyword_weight: z
					.number()
					.optional()
					.describe("Weight for keyword search (0-1, default: 0.5)"),
				semantic_weight: z
					.number()
					.optional()
					.describe("Weight for semantic search (0-1, default: 0.5)"),
				filters: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Filter by metadata"),
			},
		},
		async ({
			query,
			types,
			limit,
			offset,
			min_score,
			keyword_weight,
			semantic_weight,
			filters,
		}) => {
			if (!query || query.trim().length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Query is required.",
						},
					],
				};
			}

			try {
				const payload: Record<string, unknown> = { query };
				if (types && types.length > 0) payload.types = types;
				if (limit !== undefined) payload.limit = limit;
				if (offset !== undefined) payload.offset = offset;
				if (min_score !== undefined) payload.minScore = min_score;
				if (keyword_weight !== undefined) {
					payload.keywordWeight = keyword_weight;
				}
				if (semantic_weight !== undefined) {
					payload.semanticWeight = semantic_weight;
				}
				if (filters) payload.filters = filters;

				const response = await fetch(`${API_BASE_URL}/api/search`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-API-Key": API_KEY,
					},
					body: JSON.stringify(payload),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(
						`Search API request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
					);
				}

				const data = (await response.json()) as {
					results: Array<Record<string, unknown>>;
					total: number;
					query: string;
					semanticUsed: boolean;
					took: number;
				};

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Search results for "${data.query}" (total: ${data.total}, returned: ${data.results.length}, semanticUsed: ${data.semanticUsed}, took: ${data.took}ms)\n\n` +
								JSON.stringify(data, null, 2),
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Search failed: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Search historical status reports / completions (hybrid semantic + keyword)
	server.registerTool(
		"search_status_history",
		{
			description:
				"Search historical status reports and completions from all arms (semantic + keyword hybrid over Qdrant status-history).",
			inputSchema: {
				query: z.string().describe("Natural language search query"),
				filters: z
					.object({
						arm_ids: z.array(z.string()).optional().describe("Filter by arm IDs"),
						event_types: z
							.array(
								z.enum([
									"status_report",
									"task_completion",
									"discovery",
									"bug_report",
									"task_created",
									"task_updated",
									"arm_event",
								]),
							)
							.optional()
							.describe("Filter by event type"),
						days_back: z
							.number()
							.optional()
							.describe("Only include events from the last N days (default: 30)"),
						task_id: z.string().optional().describe("Related task ID"),
						bug_id: z.string().optional().describe("Related bug ID"),
						source: z.string().optional().describe("Event source (arm id / system)"),
						classification: z
							.string()
							.optional()
							.describe("Event classification (for example, development, bug_fix)"),
						from: z.string().optional().describe("ISO start time (overrides days_back)"),
						to: z.string().optional().describe("ISO end time"),
					})
					.optional(),
				limit: z.number().optional().describe("Max results (default: 10)"),
				keyword_weight: z
					.number()
					.optional()
					.describe("Keyword score weight 0-1 (default: 0.35)"),
				semantic_weight: z
					.number()
					.optional()
					.describe("Semantic score weight 0-1 (default: 0.65)"),
			},
		},
		async ({ query, filters, limit, keyword_weight, semantic_weight }) => {
			if (!query || query.trim().length === 0) {
				return {
					content: [{ type: "text" as const, text: "Query is required." }],
				};
			}

			try {
				const apiFilters: Record<string, unknown> = {};
				if (filters?.arm_ids) apiFilters.arm_ids = filters.arm_ids;
				if (filters?.event_types) apiFilters.event_types = filters.event_types;
				if (filters?.task_id) apiFilters.task_id = filters.task_id;
				if (filters?.bug_id) apiFilters.bug_id = filters.bug_id;
				if (filters?.source) apiFilters.source = filters.source;
				if (filters?.classification) apiFilters.classification = filters.classification;
				if (filters?.from) {
					apiFilters.from = filters.from;
				} else if (filters?.days_back !== undefined || filters?.days_back === undefined) {
					const days = filters?.days_back ?? 30;
					const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
					apiFilters.from = since.toISOString();
				}
				if (filters?.to) apiFilters.to = filters.to;

				const payload: Record<string, unknown> = {
					query,
					limit: limit ?? 10,
					include_context: true,
					filters: apiFilters,
				};
				if (keyword_weight !== undefined) payload.keywordWeight = keyword_weight;
				if (semantic_weight !== undefined) payload.semanticWeight = semantic_weight;

				const response = await fetch(`${API_BASE_URL}/api/status-history/search`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-API-Key": API_KEY,
					},
					body: JSON.stringify(payload),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(
						`Status history search failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
					);
				}

				const data = (await response.json()) as {
					results: Array<Record<string, unknown>>;
					total: number;
					query: string;
					semanticUsed: boolean;
					query_time_ms: number;
				};

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Status history for "${data.query}" (total: ${data.total}, returned: ${data.results.length}, semanticUsed: ${data.semanticUsed}, took: ${data.query_time_ms}ms)\n\n` +
								JSON.stringify(data, null, 2),
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Status history search failed: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Search historical task history with direct filters for arms / event types / time range.
	server.registerTool(
		"historical_search",
		{
			description:
				"Search historical status reports and completions with common filters for arms, event type, and date range.",
			inputSchema: {
				query: z.string().describe("Natural language search query"),
				arm_id: z.string().optional().describe("Filter by a single arm ID"),
				event_type: z
					.enum([
						"status_report",
						"task_completion",
						"discovery",
						"bug_report",
						"task_created",
						"task_updated",
						"arm_event",
					])
					.optional()
					.describe("Filter by event type"),
				days_back: z
					.number()
					.optional()
					.describe("Only include events from the last N days"),
				from: z.string().optional().describe("ISO start time (overrides days_back)"),
				to: z.string().optional().describe("ISO end time"),
				task_id: z.string().optional().describe("Related task ID"),
				bug_id: z.string().optional().describe("Related bug ID"),
				source: z.string().optional().describe("Event source (arm id / system)"),
				classification: z
					.string()
					.optional()
					.describe("Event classification (for example, development, bug_fix)"),
				limit: z.number().optional().describe("Max results (default: 10)"),
				keyword_weight: z
					.number()
					.optional()
					.describe("Keyword score weight 0-1 (default: 0.35)"),
				semantic_weight: z
					.number()
					.optional()
					.describe("Semantic score weight 0-1 (default: 0.65)"),
			},
		},
		async ({
			query,
			arm_id,
			event_type,
			days_back,
			from,
			to,
			task_id,
			bug_id,
			source,
			classification,
			limit,
			keyword_weight,
			semantic_weight,
		}) => {
			if (!query || query.trim().length === 0) {
				return {
					content: [{ type: "text" as const, text: "Query is required." }],
				};
			}

			try {
				const apiFilters: Record<string, unknown> = {};
				if (arm_id) apiFilters.arm_ids = [arm_id];
				if (event_type) apiFilters.event_types = [event_type];

				if (task_id) apiFilters.task_id = task_id;
				if (bug_id) apiFilters.bug_id = bug_id;
				if (source) apiFilters.source = source;
				if (classification) apiFilters.classification = classification;

				if (from) {
					apiFilters.from = from;
				} else {
					const back = days_back ?? 30;
					const since = new Date(Date.now() - back * 24 * 60 * 60 * 1000);
					apiFilters.from = since.toISOString();
				}

				if (to) apiFilters.to = to;

				const payload: Record<string, unknown> = {
					query,
					limit: limit ?? 10,
					include_context: true,
					filters: apiFilters,
				};
				if (keyword_weight !== undefined) payload.keywordWeight = keyword_weight;
				if (semantic_weight !== undefined) payload.semanticWeight = semantic_weight;

				const response = await fetch(`${API_BASE_URL}/api/status-history/search`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-API-Key": API_KEY,
					},
					body: JSON.stringify(payload),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(
						`Status history search failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
					);
				}

				const data = (await response.json()) as {
					results: Array<Record<string, unknown>>;
					total: number;
					query: string;
					semanticUsed: boolean;
					query_time_ms: number;
				};

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Status history for "${data.query}" (total: ${data.total}, returned: ${data.results.length}, semanticUsed: ${data.semanticUsed}, took: ${data.query_time_ms}ms)\n\n` +
								JSON.stringify(data, null, 2),
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Status history search failed: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// ============================================
	// DEV SERVER MANAGEMENT TOOLS
	// ============================================

	// Global dev server monitoring state
	const monitoredServers = new Map<
		string,
		{
			process: any;
			logs: string[];
			maxLogs: number;
			startTime: Date;
			status: "running" | "stopped" | "error";
			framework: string;
		}
	>();

	// Helper function to detect development server framework
	function detectDevServerFramework(command: string): string {
		if (command.includes("vite")) return "vite";
		if (command.includes("next")) return "next.js";
		if (command.includes("bun") && command.includes("dev")) return "bun";
		if (command.includes("npm") && command.includes("dev")) return "npm/node";
		if (command.includes("yarn") && command.includes("dev")) return "yarn";
		return "unknown";
	}

	// Helper function to find running dev server processes
	async function findDevServerProcesses(): Promise<
		Array<{ pid: number; command: string; framework: string }>
	> {
		try {
			const { spawn } = await import("child_process");
			const { promisify } = await import("util");

			return new Promise((resolve) => {
				const ps = spawn("ps", ["aux"]);
				let output = "";

				ps.stdout.on("data", (data) => {
					output += data.toString();
				});

				ps.on("close", () => {
					const lines = output.split("\n");
					const servers: Array<{
						pid: number;
						command: string;
						framework: string;
					}> = [];

					for (const line of lines) {
						if (
							line.includes("vite") ||
							line.includes("next") ||
							(line.includes("bun") && line.includes("dev")) ||
							(line.includes("npm") && line.includes("dev")) ||
							(line.includes("yarn") && line.includes("dev"))
						) {
							const parts = line.trim().split(/\s+/);
							if (parts.length >= 2 && parts[1]) {
								const pid = parseInt(parts[1]);
								const command = parts.slice(10).join(" ");
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
			console.error("Error finding dev server processes:", err);
			return [];
		}
	}

	// Monitor a development server process
	server.registerTool(
		"monitor_dev_server",
		{
			description:
				"Start monitoring a development server process for logs and status. Use this to track Vite, Next.js, Bun, or other dev servers.",
			inputSchema: {
				server_id: z
					.string()
					.describe(
						"Unique identifier for this dev server (e.g., 'web-frontend', 'api-server')",
					),
				pid: z
					.number()
					.optional()
					.describe(
						"Process ID to monitor (if not provided, will auto-detect)",
					),
				command: z
					.string()
					.optional()
					.describe("Command that started the server (for reference)"),
				max_logs: z
					.number()
					.default(1000)
					.describe("Maximum number of log lines to keep in memory"),
			},
		},
		async ({ server_id, pid, command, max_logs = 1000 }) => {
			try {
				// If no PID provided, try to auto-detect
				if (!pid) {
					const processes = await findDevServerProcesses();
					if (processes.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: "No development server processes found running. Please start a dev server first or provide a specific PID.",
								},
							],
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
						const processList = processes
							.map((p) => `  PID ${p.pid}: ${p.framework} - ${p.command}`)
							.join("\n");
						return {
							content: [
								{
									type: "text" as const,
									text: `Multiple dev servers found. Please specify a PID:\n\n${processList}\n\nCall this tool again with the specific pid parameter.`,
								},
							],
						};
					}
				}

				const framework = command
					? detectDevServerFramework(command)
					: "unknown";

				// Ensure we have a valid PID at this point
				if (!pid) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Unable to determine process ID. Please provide a specific PID.",
							},
						],
					};
				}

				// Initialize monitoring state
				monitoredServers.set(server_id, {
					process: { pid },
					logs: [],
					maxLogs: max_logs,
					startTime: new Date(),
					status: "running",
					framework,
				});

				// Log the monitoring start
				logActivity(ARM_ID, "monitor_dev_server", server_id, {
					pid,
					framework,
					command,
				});

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Started monitoring dev server '${server_id}'\n\n` +
								`PID: ${pid}\n` +
								`Framework: ${framework}\n` +
								`Command: ${command || "N/A"}\n` +
								`Max logs: ${max_logs}\n\n` +
								`Use 'get_dev_server_logs' to retrieve logs and 'get_dev_server_status' to check status.`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to start monitoring: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Get development server logs
	server.registerTool(
		"get_dev_server_logs",
		{
			description:
				"Retrieve recent logs from a monitored development server. This provides real-time access to dev server output.",
			inputSchema: {
				server_id: z
					.string()
					.describe("Server identifier from monitor_dev_server"),
				tail_lines: z
					.number()
					.default(50)
					.describe("Number of recent log lines to retrieve"),
				filter: z
					.string()
					.optional()
					.describe("Optional filter string to search for in logs"),
			},
		},
		async ({ server_id, tail_lines = 50, filter }) => {
			try {
				const serverInfo = monitoredServers.get(server_id);
				if (!serverInfo) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Dev server '${server_id}' is not being monitored. Use 'monitor_dev_server' first.`,
							},
						],
					};
				}

				// For now, we'll read logs from the process stdout/stderr
				// In a real implementation, we'd capture the actual process output
				const { spawn } = await import("child_process");

				// Get recent logs using journalctl or system logs for the PID
				const logCmd = spawn("ps", [
					"-p",
					serverInfo.process.pid.toString(),
					"-o",
					"pid,ppid,cmd",
				]);
				let processInfo = "";

				logCmd.stdout.on("data", (data) => {
					processInfo += data.toString();
				});

				await new Promise((resolve) => {
					logCmd.on("close", resolve);
				});

				if (!processInfo.includes(serverInfo.process.pid.toString())) {
					serverInfo.status = "stopped";
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Dev server '${server_id}' (PID ${serverInfo.process.pid}) is no longer running.\n\n` +
									`Status: ${serverInfo.status}\n` +
									`Framework: ${serverInfo.framework}\n` +
									`Started: ${serverInfo.startTime.toISOString()}`,
							},
						],
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
					logs = logs.filter((log) =>
						log.toLowerCase().includes(filter.toLowerCase()),
					);
				}

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Recent logs for dev server '${server_id}' (${logs.length} lines):\n\n` +
								logs.join("\n") +
								"\n\n" +
								`Note: Full log capture implementation in progress. ` +
								`Currently showing process status and basic monitoring info.`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to get logs for '${server_id}': ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Get development server status
	server.registerTool(
		"get_dev_server_status",
		{
			description:
				"Check the health and status of monitored development servers.",
			inputSchema: {
				server_id: z
					.string()
					.optional()
					.describe(
						"Specific server ID to check (if omitted, shows all monitored servers)",
					),
			},
		},
		async ({ server_id }) => {
			try {
				if (server_id) {
					const serverInfo = monitoredServers.get(server_id);
					if (!serverInfo) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Dev server '${server_id}' is not being monitored.`,
								},
							],
						};
					}

					// Check if process is still running
					try {
						const { spawn } = await import("child_process");
						const checkCmd = spawn("ps", [
							"-p",
							serverInfo.process.pid.toString(),
						]);

						await new Promise((resolve, reject) => {
							checkCmd.on("close", (code) => {
								if (code === 0) {
									serverInfo.status = "running";
								} else {
									serverInfo.status = "stopped";
								}
								resolve(code);
							});
							checkCmd.on("error", reject);
						});
					} catch {
						serverInfo.status = "error";
					}

					const uptime = new Date().getTime() - serverInfo.startTime.getTime();
					const uptimeStr = Math.floor(uptime / 1000 / 60); // minutes

					return {
						content: [
							{
								type: "text" as const,
								text:
									`Status for dev server '${server_id}':\n\n` +
									`PID: ${serverInfo.process.pid}\n` +
									`Status: ${serverInfo.status}\n` +
									`Framework: ${serverInfo.framework}\n` +
									`Started: ${serverInfo.startTime.toISOString()}\n` +
									`Uptime: ${uptimeStr} minutes\n` +
									`Logs cached: ${serverInfo.logs.length}/${serverInfo.maxLogs}`,
							},
						],
					};
				} else {
					// Show all monitored servers
					if (monitoredServers.size === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: "No development servers are currently being monitored.\n\nUse 'monitor_dev_server' to start monitoring.",
								},
							],
						};
					}

					const statusList: string[] = [];
					for (const [id, info] of monitoredServers.entries()) {
						const uptime = Math.floor(
							(new Date().getTime() - info.startTime.getTime()) / 1000 / 60,
						);
						statusList.push(
							`${id}: ${info.status} (${info.framework}, PID ${info.process.pid}, ${uptime}m)`,
						);
					}

					return {
						content: [
							{
								type: "text" as const,
								text:
									`Monitored development servers (${monitoredServers.size}):\n\n` +
									statusList.join("\n") +
									"\n\n" +
									`Use 'get_dev_server_status' with server_id for detailed info.`,
							},
						],
					};
				}
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to get status: ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Request development server restart (requires brain coordination)
	server.registerTool(
		"restart_dev_server",
		{
			description:
				"Request a development server restart. This is a destructive operation that goes through the brain for coordination with other arms.",
			inputSchema: {
				server_id: z.string().describe("Server identifier to restart"),
				reason: z
					.string()
					.describe(
						"Reason for requesting restart (e.g., 'config changes', 'dependency updates')",
					),
				force: z
					.boolean()
					.default(false)
					.describe("Force restart even if files are claimed by other arms"),
			},
		},
		async ({ server_id, reason, force = false }) => {
			try {
				const serverInfo = monitoredServers.get(server_id);
				if (!serverInfo) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Dev server '${server_id}' is not being monitored. Use 'monitor_dev_server' first.`,
							},
						],
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
				logActivity(ARM_ID, "request_dev_server_restart", server_id, {
					reason,
					force,
					pid: serverInfo.process.pid,
					messageId,
				});

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Restart request sent to brain for dev server '${server_id}'\n\n` +
								`PID: ${serverInfo.process.pid}\n` +
								`Framework: ${serverInfo.framework}\n` +
								`Reason: ${reason}\n` +
								`Force: ${force}\n` +
								`Request ID: ${messageId}\n\n` +
								`The brain will coordinate with other arms and check file claims before proceeding. ` +
								`You will be notified of the decision on your next poll cycle.`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to request restart for '${server_id}': ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// Stop monitoring a development server
	server.registerTool(
		"stop_monitoring_dev_server",
		{
			description:
				"Stop monitoring a development server. This only stops the monitoring, it does not stop the server process.",
			inputSchema: {
				server_id: z.string().describe("Server identifier to stop monitoring"),
			},
		},
		async ({ server_id }) => {
			try {
				const serverInfo = monitoredServers.get(server_id);
				if (!serverInfo) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Dev server '${server_id}' is not being monitored.`,
							},
						],
					};
				}

				// Remove from monitoring
				monitoredServers.delete(server_id);

				// Log the stop monitoring action
				logActivity(ARM_ID, "stop_monitoring_dev_server", server_id, {
					pid: serverInfo.process.pid,
					framework: serverInfo.framework,
				});

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Stopped monitoring dev server '${server_id}'\n\n` +
								`PID: ${serverInfo.process.pid}\n` +
								`Framework: ${serverInfo.framework}\n\n` +
								`The server process is still running. This only stopped the monitoring.`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to stop monitoring '${server_id}': ${errorMsg}`,
						},
					],
				};
			}
		},
	);

	// ============================================
	// BRAIN INTELLIGENCE TOOLS - Rich context from the brain
	// ============================================

	// Get task determination (what should the brain decide to work on next?)
	server.registerTool(
		"get_task_determination",
		{
			description:
				"Get the brain's task determination - what task should be worked on next based on the plan, completed tasks, and open discoveries. This uses the same logic as 'octopai brain prompt:task' CLI command.",
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
					db: database as unknown as PromptContext["db"],
				};

				const result = await generateTaskDetermination(
					ctx,
					buildTaskDeterminationOptionsForArm(),
				);
				updateCompletionExclusionAfterDetermination(result);
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
		},
	);

	// Get context bundle for a specific task
	server.registerTool(
		"get_context_bundle",
		{
			description:
				"Get the full context bundle for a specific task, including discoveries, plan excerpt, task history, and instructions. This uses the same logic as 'octopai brain prompt:context' CLI command.",
			inputSchema: {
				task_subject: z
					.string()
					.describe("The task subject or ID to get context for"),
			},
		},
		async ({ task_subject }) => {
			try {
				const database = getDatabase();

				const ctx: PromptContext = {
					projectRoot: PROJECT_ROOT,
					coleoDir: COLEO_DIR,
					db: database as unknown as PromptContext["db"],
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
		},
	);

	// Get full briefing (task determination + context bundle in one call)
	server.registerTool(
		"get_full_briefing",
		{
			description:
				"Get a complete briefing: the brain's task determination AND the full context bundle for that task. This is the recommended way to start work - it combines 'get_task_determination' and 'get_context_bundle' into a single call for efficiency. After reviewing the briefing, use 'claim_task' to claim ownership of the task.",
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
					db: database as unknown as PromptContext["db"],
				};

				// Step 1: Get task determination
				const determination = await generateTaskDetermination(
					ctx,
					buildTaskDeterminationOptionsForArm(),
				);
				updateCompletionExclusionAfterDetermination(determination);
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
								text:
									determinationFormatted +
									"\n\n---\n\nNo task was determined, so no context bundle is available.",
							},
						],
					};
				}

				// Step 2: Get context bundle for the determined task
				const contextLookupTarget =
					determination.task.id || determination.task.subject;
				const contextBundle = await generateContextBundle(
					ctx,
					contextLookupTarget,
				);

				let fullBriefing = determinationFormatted;

				if (contextBundle) {
					const contextFormatted = formatContextBundle(contextBundle);
					fullBriefing += "\n" + "=".repeat(60) + "\n\n" + contextFormatted;
				} else {
					fullBriefing +=
						"\n---\n\n*Context bundle could not be generated for this task.*";
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
		},
	);

	// Get recent events for this arm
	server.registerTool(
		"get_arm_events",
		{
			description:
				"Get recent events from this arm's OpenCode session. Events include session compaction, message updates, tool invocations, and other session activity. Use this to monitor session state and detect important changes.",
			inputSchema: {
				limit: z
					.number()
					.optional()
					.describe(
						"Maximum number of events to return (default: 20, max: 100)",
					),
				since: z
					.string()
					.optional()
					.describe("Only return events after this ISO timestamp"),
				event_type: z
					.string()
					.optional()
					.describe(
						"Filter by specific event type (e.g., 'session.compacted', 'message.updated')",
					),
			},
		},
		async ({ limit = 20, since, event_type }) => {
			console.error(
				`[MCP] get_arm_events called by ${ARM_ID} (limit: ${limit}, since: ${since}, type: ${event_type})`,
			);

			try {
				// Query the main server for stored events
				const params = new URLSearchParams();
				params.set("limit", Math.min(limit, 100).toString());
				if (since) params.set("since", since);
				if (event_type) params.set("type", event_type);

				const response = await fetch(
					`${API_BASE_URL}/api/arms/${ARM_ID}/stored-events?${params}`,
					{
						headers: {
							"X-API-Key": API_KEY,
						},
					},
				);

				if (!response.ok) {
					throw new Error(
						`API request failed: ${response.status} ${response.statusText}`,
					);
				}

				const data = (await response.json()) as {
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
				const eventSummary = data.events
					.map(
						(event) =>
							`- **${event.timestamp}** | ${event.type}: ${JSON.stringify(event.data, null, 2).slice(0, 200)}${JSON.stringify(event.data, null, 2).length > 200 ? "..." : ""}`,
					)
					.join("\n");

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
		},
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
			description:
				"Get the status of Coleo services (server, brain). Always available.",
			inputSchema: {
				service: z
					.enum(["server", "brain", "all"])
					.describe("Which service to check"),
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
		},
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
				service: z
					.enum(["server", "brain"])
					.describe("Which service to restart"),
				force: z
					.boolean()
					.optional()
					.describe("Force kill if graceful shutdown fails"),
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
				console.error(
					`[MCP] service_restart called by ${ARM_ID} for ${service}`,
				);
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
		},
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
				force: z
					.boolean()
					.optional()
					.describe("Force kill if graceful shutdown fails"),
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
				console.error(
					`[MCP] WARNING: ${ARM_ID} is stopping the server - this arm will lose connection!`,
				);
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
		},
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
		},
	);

	// ============================================
	// Task Preparation Agent and Handoff Tools
	// ============================================

	// prepare_task: Architect agent can prepare a detailed task definition from discussion
	server.registerTool(
		"prepare_task",
		{
			description:
				"Prepare a detailed task definition for handoff. Use this after discussing task requirements to create a clean, actionable task that other arms can execute.",
			inputSchema: {
				subject: z.string().describe("Clear title for the task"),
				description: z
					.string()
					.describe(
						"Detailed description including context, requirements, and acceptance criteria",
					),
				priority: z
					.enum(["low", "normal", "high"])
					.optional()
					.describe("Task priority (defaults to normal)"),
				discussion_id: z
					.string()
					.optional()
					.describe(
						"ID of the discussion that informed this task preparation (if applicable)",
					),
				related_plan_id: z
					.string()
					.optional()
					.describe(
						"Plan document ID that this task relates to (if applicable)",
					),
				estimated_effort: z
					.string()
					.optional()
					.describe("Estimate of effort (e.g., '2-3 hours', '1 day')"),
			},
		},
		async ({
			subject,
			description,
			priority = "normal",
			discussion_id,
			related_plan_id,
			estimated_effort,
		}) => {
			try {
				// Validate required fields
				if (!subject?.trim()) {
					return {
						content: [{ type: "text", text: "Subject is required" }],
					};
				}
				if (!description?.trim()) {
					return {
						content: [{ type: "text", text: "Description is required" }],
					};
				}

				// Get writable database connection
				const db = getDatabase(true);
				if (!db) {
					return {
						content: [{ type: "text", text: "Database connection failed" }],
						isError: true,
					};
				}

				// Generate unique task ID
				const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

				// Build task description
				const taskDescription = [
					description,
					estimated_effort ? `**Estimated Effort:** ${estimated_effort}` : "",
				]
					.filter(Boolean)
					.join("\n\n");

					// Insert task into database with prepared_by_arm_id
					// TODO refactor this into the API server and the brain
					db.run(
						`INSERT INTO tasks (
            id, subject, description, status, priority, classification,
            domain, assigned_to, created_at, updated_at,
            prepared_by_arm_id, prepared_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
						[
							taskId,
							subject,
							taskDescription,
							"pending",
							priority,
							"development", // Prepared tasks are typically development tasks
							null, // domain (unscoped)
							null, // unassigned so any arm can claim
							new Date().toISOString(),
							new Date().toISOString(),
							ARM_ID,
							new Date().toISOString(),
						],
					);

				// Log activity
				logActivity(ARM_ID, "prepare_task", taskId, {
					subject,
					priority,
					discussion_id,
					related_plan_id,
					estimated_effort,
				});

				// Get the task for response
				const task = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as
					| { id: string; subject: string; status: string; priority: string }
					| undefined;

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Task prepared successfully!\n\n` +
								`ID: ${task?.id || taskId}\n` +
								`Subject: ${task?.subject || subject}\n` +
								`Status: ${task?.status || "pending"}\n` +
								`Priority: ${task?.priority || priority}\n` +
								`Prepared by: ${ARM_ID}\n\n` +
								`This task is now available for other arms to claim and execute.`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				logActivity(ARM_ID, "prepare_task_error", undefined, {
					error: errorMsg,
				});
				return {
					content: [
						{ type: "text", text: `Failed to prepare task: ${errorMsg}` },
					],
					isError: true,
				};
			}
		},
	);

	// ============================================
	// RESOURCES - Data arms can read
	// ============================================
	registerResources(server);

	// update_task_summary: record a work-in-progress summary on a task as
	// the arm/brain makes progress
	server.registerTool(
		"update_task_summary",
		{
			description:
				"Record a work-in-progress summary on a task. Call this as you make " +
				"progress so the task's Summary tab shows an up-to-date account of " +
				"what's been done. Each call appends a new entry; the most recent one " +
				"is shown as the current summary.",
			inputSchema: {
				task_id: z.string().describe("ID of the task to summarize"),
				content: z.string().describe("Summary of progress/work done so far"),
			},
		},
		async ({ task_id, content }) => {
			try {
				const response = await fetch(
					`${API_BASE_URL}/api/tasks/${encodeURIComponent(task_id)}/summaries`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-API-Key": API_KEY,
						},
						body: JSON.stringify({
							content,
							authorType: "arm",
							authorId: ARM_ID,
						}),
					},
				);

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(
						`Failed to record summary: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
					);
				}

				logActivity(ARM_ID, "update_task_summary", task_id, {
					contentLength: content.length,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `Summary recorded on task ${task_id}.`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{ type: "text" as const, text: `Failed to record summary: ${errorMsg}` },
					],
					isError: true,
				};
			}
		},
	);

	// record_task_diff: record a unified diff of changes made while working
	// on a task
	server.registerTool(
		"record_task_diff",
		{
			description:
				"Record a unified diff of code changes made while working on a task. " +
				"Call this after making meaningful edits so the task's Diff tab shows " +
				"what changed. Additions/deletions are auto-computed from the diff if " +
				"not provided.",
			inputSchema: {
				task_id: z.string().describe("ID of the task these changes belong to"),
				diff: z.string().describe("Unified diff text (e.g. `git diff` output)"),
				title: z
					.string()
					.optional()
					.describe("Short label for this diff (e.g. the change summary)"),
				file_path: z
					.string()
					.optional()
					.describe("Primary file path this diff touches, if a single file"),
				additions: z
					.number()
					.optional()
					.describe("Explicit added-line count (auto-computed if omitted)"),
				deletions: z
					.number()
					.optional()
					.describe("Explicit removed-line count (auto-computed if omitted)"),
			},
		},
		async ({ task_id, diff, title, file_path, additions, deletions }) => {
			try {
				const payload: Record<string, unknown> = {
					diff,
					authorType: "arm",
					authorId: ARM_ID,
				};
				if (title) payload.title = title;
				if (file_path) payload.filePath = file_path;
				if (additions !== undefined) payload.additions = additions;
				if (deletions !== undefined) payload.deletions = deletions;

				const response = await fetch(
					`${API_BASE_URL}/api/tasks/${encodeURIComponent(task_id)}/diffs`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-API-Key": API_KEY,
						},
						body: JSON.stringify(payload),
					},
				);

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(
						`Failed to record diff: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
					);
				}

				const data = (await response.json()) as {
					diff: { additions: number; deletions: number };
				};

				logActivity(ARM_ID, "record_task_diff", task_id, {
					additions: data.diff.additions,
					deletions: data.diff.deletions,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `Diff recorded on task ${task_id} (+${data.diff.additions}/-${data.diff.deletions}).`,
						},
					],
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{ type: "text" as const, text: `Failed to record diff: ${errorMsg}` },
					],
					isError: true,
				};
			}
		},
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
