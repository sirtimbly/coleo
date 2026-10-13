/**
 * Reporting Tools
 * 
 * MCP tools for reporting discoveries, bugs, and dependencies.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Discovery } from "../../types";
import { broadcast } from "../../api/websocket";
import {
	ARM_ID,
	sendToBrain,
	logActivity,
	getDatabase,
	resolveTaskReferenceForTool,
} from "./utils";

/**
 * Register reporting-related tools on the MCP server
 */
export function registerReportingTools(server: McpServer): void {
	// Report something interesting found while working
	server.registerTool(
		"report_discovery",
		{
			description:
				"Report something interesting found while working. Use during exploration phase to report context gaps, ambiguous requirements, blockers, related code, and suggested approaches.",
			inputSchema: {
				kind: z
					.enum([
						"test_failure",
						"unused_code",
						"security_issue",
						"performance",
						"pattern",
						"missing_context",
						"ambiguous_requirement",
						"potential_blocker",
						"related_code",
						"suggested_approach",
						"other",
					])
					.describe(
						"Type of discovery: exploration kinds (missing_context, ambiguous_requirement, potential_blocker, related_code, suggested_approach) or implementation kinds (test_failure, unused_code, security_issue, performance, pattern, other)",
					),
				title: z.string().describe("Brief title"),
				details: z.string().describe("Detailed description"),
				file: z.string().optional().describe("Related file path"),
				line: z.number().optional().describe("Line number if applicable"),
				severity: z
					.enum(["info", "warning", "error"])
					.optional()
					.describe("Severity level"),
				task_id: z
					.string()
					.optional()
					.describe(
						"Task ID this discovery relates to (important for exploration phase)",
					),
				phase: z
					.enum(["exploration", "implementation", "verification"])
					.optional()
					.describe(
						"Phase when discovery was made: exploration (before changes), implementation (during changes), verification (testing/review)",
					),
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

			logActivity(ARM_ID, "report_discovery", task_id, {
				messageId,
				kind,
				title,
				details,
				severity,
				file,
				line,
				taskId: task_id,
				phase,
			});

			const phaseNote =
				phase === "exploration"
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
		},
	);

	// Resolve or dismiss a discovery
	server.registerTool(
		"resolve_discovery",
		{
			description:
				"Mark a discovery as resolved or dismissed. Use when you find that a previously reported blocker, issue, or concern is no longer valid or has been fixed.",
			inputSchema: {
				discovery_id: z
					.string()
					.optional()
					.describe("The ID of the discovery to resolve (if known)"),
				title_match: z
					.string()
					.optional()
					.describe("Partial title to match if ID is not known"),
				resolution: z
					.enum(["resolved", "dismissed"])
					.describe(
						"resolved = issue was fixed/addressed, dismissed = issue was not actually valid",
					),
				reason: z
					.string()
					.describe(
						"Explanation of why this discovery is being resolved/dismissed",
					),
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
				discovery = db
					.query(`
          SELECT id, title, kind FROM discoveries WHERE id = ? AND status = 'open'
        `)
					.get(discovery_id) as DiscoveryRow;
			} else if (title_match) {
				// Find by title match (most recent open discovery matching the title)
				discovery = db
					.query(`
          SELECT id, title, kind FROM discoveries
          WHERE status = 'open' AND title LIKE ?
          ORDER BY created_at DESC LIMIT 1
        `)
					.get(`%${title_match}%`) as DiscoveryRow;
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
			db.run(
				`
        UPDATE discoveries
        SET status = ?,
            updated_at = ?,
            metadata = json_set(COALESCE(metadata, '{}'), '$.resolution_reason', ?, '$.resolved_by', ?, '$.resolved_at', ?)
        WHERE id = ?
      `,
				[resolution, now, reason, ARM_ID, now, discovery.id],
			);

			// Log the activity
			logActivity(ARM_ID, "resolve_discovery", discovery.id, {
				title: discovery.title,
				kind: discovery.kind,
				resolution,
				reason,
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
		},
	);

	// Report task dependency discovered during execution
	server.registerTool(
		"report_dependency",
		{
			description:
				"Report a dependency relationship discovered during task execution",
			inputSchema: {
				task_id: z
					.string()
					.describe("The ID of the task this dependency relates to"),
				depends_on: z
					.string()
					.describe(
						"What this task depends on (file, component, service, etc.)",
					),
				dependency_type: z
					.enum(["file", "component", "service", "external", "data", "other"])
					.describe("Type of dependency"),
				description: z
					.string()
					.describe("Description of the dependency relationship"),
				severity: z
					.enum(["info", "warning", "blocking"])
					.optional()
					.describe("How critical this dependency is"),
			},
		},
		async ({ task_id, depends_on, dependency_type, description, severity }) => {
			const resolution = resolveTaskReferenceForTool(task_id);
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

			const resolvedTaskId = resolution.taskId;
			const dependency = {
				taskId: resolvedTaskId,
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

			logActivity(ARM_ID, "report_dependency", resolvedTaskId, {
				messageId,
				dependsOn: depends_on,
				type: dependency_type,
				severity,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `${resolution.note ? `${resolution.note}\n\n` : ""}Dependency reported: ${depends_on} (${dependency_type}) for task ${resolvedTaskId} (message: ${messageId}). Brain will track this relationship.`,
					},
				],
			};
		},
	);

	// Report a bug encountered during execution
	server.registerTool(
		"report_bug",
		{
			description:
				"Report a bug encountered during task execution. Use this for compilation errors, test failures, runtime crashes, or other issues that prevent task completion.",
			inputSchema: {
				title: z.string().describe("Brief title describing the bug"),
				description: z
					.string()
					.describe(
						"Detailed description of the bug, including steps to reproduce and error messages",
					),
				source: z
					.enum(["arm_reported", "human_reported", "system_detected"])
					.optional()
					.default("arm_reported")
					.describe(
						"Who reported this bug: arm_reported (default), human_reported (from human email), or system_detected (automated detection)",
					),
				source_task_id: z
					.string()
					.optional()
					.describe("ID of the task where the bug was encountered"),
				error_details: z
					.string()
					.optional()
					.describe(
						"JSON string with additional error details like stack traces",
					),
			},
		},
		async ({
			title,
			description,
			source = "arm_reported",
			source_task_id,
			error_details,
		}) => {
			const bugPayload = {
				id: `bug-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				title,
				description,
				source: source as "arm_reported" | "human_reported" | "system_detected",
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
				description,
				source,
				sourceTaskId: source_task_id,
				errorDetails: error_details,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Bug reported: ${title} (message: ${messageId}). Brain will process and may create investigation tasks.`,
					},
				],
			};
		},
	);

	// Update bug status during investigation/fix process
	server.registerTool(
		"update_bug_status",
		{
			description:
				"Update the status of a bug during investigation or resolution. Use this to mark bugs as investigating, fixing, verifying, resolved, or closed.",
			inputSchema: {
				bug_id: z.string().describe("ID of the bug to update"),
				status: z
					.enum([
						"open",
						"investigating",
						"fixing",
						"verifying",
						"resolved",
						"closed",
					])
					.describe("New status for the bug"),
				resolution: z
					.string()
					.optional()
					.describe("Resolution details if marking as resolved"),
				assignee_arm_id: z
					.string()
					.optional()
					.describe("Assign this bug to a specific arm"),
			},
		},
		async ({ bug_id, status, resolution, assignee_arm_id }) => {
			const database = getDatabase();

			try {
				// Get current bug
				const existingBug = database
					.query("SELECT * FROM bugs WHERE id = ?")
					.get(bug_id) as any;
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

				if (
					assignee_arm_id &&
					assignee_arm_id !== existingBug.assignee_arm_id
				) {
					updates.push("assignee_arm_id = ?");
					params.push(assignee_arm_id);
				}

				if (status === "resolved" || status === "closed") {
					updates.push("resolved_at = ?");
					params.push(now);
					// Reset human_notified flag so resolution notification can be sent
					updates.push("human_notified = 0");
				}

				updates.push("updated_at = ?");
				params.push(now);

				if (updates.length > 1) {
					// More than just updated_at
					const result = database.run(
						`UPDATE bugs SET ${updates.join(", ")} WHERE id = ?`,
						[...params, bug_id],
					);

					if (result.changes > 0) {
						// Broadcast update
						broadcast("bugs", "bug.updated", {
							bugId: bug_id,
							updates: { status, resolution, assigneeArmId: assignee_arm_id },
						});

						// Notify brain when bug is resolved or closed
						if (status === "resolved" || status === "closed") {
							try {
								await sendToBrain({
									from: ARM_ID,
									to: "brain",
									type: "bug_report",
									payload: {
										id: bug_id,
										title: existingBug.title,
										description: existingBug.description,
										status,
										resolution: resolution || `${status} by ${ARM_ID}`,
										source: "arm_reported",
										sourceTaskId: undefined,
										errorDetails: undefined,
									},
								});
								console.log(`[MCP] Notified brain about bug ${bug_id} completion`);
							} catch (err) {
								console.error(`[MCP] Failed to notify brain about bug completion: ${err}`);
								// Continue even if notification fails
							}
						}

						logActivity(ARM_ID, "update_bug_status", bug_id, {
							status,
							resolution: resolution ? "provided" : undefined,
							assignee: assignee_arm_id,
						});

						const text = `Bug ${bug_id} updated: status=${status}${resolution ? `, resolution provided` : ""}${assignee_arm_id ? `, assigned to ${assignee_arm_id}` : ""}`;

						return {
							content: [
								{
									type: "text" as const,
									text,
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
				return {
					content: [
						{
							type: "text" as const,
							text: `Error updating bug ${bug_id}: ${err}`,
						},
					],
				};
			}
		},
	);
}
