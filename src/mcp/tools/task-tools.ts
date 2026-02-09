/**
 * Task Tools
 * 
 * MCP tools for task management: claiming, completing, and reporting on tasks.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ARM_ID, sendToBrain, logActivity } from "./utils";

/**
 * Register task-related tools on the MCP server
 */
export function registerTaskTools(server: McpServer): void {
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
		},
	);

	// Complete a task
	server.registerTool(
		"complete_task",
		{
			description: "Mark a task as complete with a summary",
			inputSchema: {
				task_id: z.string().describe("The ID of the task"),
				summary: z.string().describe("Summary of what was done"),
				artifacts: z
					.array(z.string())
					.optional()
					.describe("Related artifacts (commit hashes, file paths, etc.)"),
			},
		},
		async ({ task_id, summary, artifacts }) => {
			console.error(
				`[MCP] complete_task called by ${ARM_ID} for task ${task_id}`,
			);
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

			logActivity(ARM_ID, "complete_task", task_id, {
				messageId,
				artifactCount: (artifacts || []).length,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Task ${task_id} marked complete. Summary sent to brain (message: ${messageId}).`,
					},
				],
			};
		},
	);

	// Submit a status report for a task
	server.registerTool(
		"submit_status_report",
		{
			description:
				"Submit a status report for a task in progress or just completed. Use this to report issues, blockers, or completion with issues that require brain re-evaluation.",
			inputSchema: {
				task_id: z.string().describe("The ID of the task this report is for"),
				status: z
					.enum([
						"on_track",
						"blocked",
						"issues_found",
						"needs_review",
						"completed_with_issues",
					])
					.describe(
						"Current status: on_track (normal progress), blocked (cannot continue), issues_found (found problems), needs_review (needs human/other arm review), completed_with_issues (done but with problems)",
					),
				summary: z
					.string()
					.describe("Summary of current progress or completion state"),
				issues: z
					.array(z.string())
					.optional()
					.describe("List of issues discovered during work"),
				blockers: z
					.array(z.string())
					.optional()
					.describe("List of blockers preventing progress"),
				next_steps: z
					.string()
					.optional()
					.describe("Suggested next steps if issues were found"),
				files_changed: z
					.array(z.string())
					.optional()
					.describe("List of files modified"),
				tests_status: z
					.enum(["passing", "failing", "not_run"])
					.optional()
					.describe("Status of tests if run"),
				screenshot_path: z
					.string()
					.optional()
					.describe("(optional) Path to screenshot showing the work"),
			},
		},
		async ({
			task_id,
			status,
			summary,
			issues,
			blockers,
			next_steps,
			files_changed,
			tests_status,
			screenshot_path,
		}) => {
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
					screenshotPath: screenshot_path,
				},
			});

			logActivity(ARM_ID, "submit_status_report", task_id, {
				messageId,
				reportId,
				status,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Status report ${reportId} submitted for task ${task_id} (message: ${messageId}).`,
					},
				],
			};
		},
	);

	// Acknowledge a task
	server.registerTool(
		"acknowledge_task",
		{
			description: "Acknowledge that you've received and started working on a task",
			inputSchema: {
				task_id: z.string().describe("The ID of the task"),
				screenshot_path: z
					.string()
					.optional()
					.describe("(optional) Path to screenshot showing the work"),
			},
		},
		async ({ task_id, screenshot_path }) => {
			console.error(
				`[MCP] acknowledge_task called by ${ARM_ID} for task ${task_id}`,
			);
			const messageId = await sendToBrain({
				from: ARM_ID,
				to: "brain",
				type: "task_acknowledge",
				payload: {
					taskId: task_id,
					screenshotPath: screenshot_path,
				},
			});

			logActivity(ARM_ID, "acknowledge_task", task_id, { messageId });

			return {
				content: [
					{
						type: "text" as const,
						text: `Task ${task_id} acknowledged (message: ${messageId}).`,
					},
				],
			};
		},
	);

	// Validate a task completion
	server.registerTool(
		"validate_task",
		{
			description:
				"Validate a task completion as the assigned validator. Report whether the work is complete and correct.",
			inputSchema: {
				task_id: z.string().describe("The ID of the task being validated"),
				approved: z
					.boolean()
					.describe("Whether the task completion is approved (true) or rejected (false)"),
				notes: z
					.string()
					.describe("Validation notes explaining your decision"),
				screenshot_path: z
					.string()
					.optional()
					.describe("(optional) Path to screenshot showing the work"),
			},
		},
		async ({ task_id, approved, notes, screenshot_path }) => {
			console.error(
				`[MCP] validate_task called by ${ARM_ID} for task ${task_id}`,
			);
			const messageId = await sendToBrain({
				from: ARM_ID,
				to: "brain",
				type: "task_validate",
				payload: {
					taskId: task_id,
					approved,
					notes,
					screenshotPath: screenshot_path,
				},
			});

			logActivity(ARM_ID, "validate_task", task_id, { messageId, approved });

			return {
				content: [
					{
						type: "text" as const,
						text: `Task ${task_id} validation submitted: ${approved ? "APPROVED" : "REJECTED"} (message: ${messageId}).`,
					},
				],
			};
		},
	);

	// Get my instructions
	server.registerTool(
		"get_my_instructions",
		{
			description:
				"Get tasks and instructions assigned to this arm by the brain. Call this when you first start to see what you should work on.",
			inputSchema: {},
		},
		async () => {
			console.error(`[MCP] get_my_instructions called by ${ARM_ID}`);

			// Import here to avoid circular dependencies
			const { getPendingTasks } = await import("./utils");
			const tasks = await getPendingTasks();

			// Find tasks assigned to this arm
			const myTasks = tasks.filter(
				(t) => t.assignedTo === ARM_ID || t.status === "pending",
			);

			if (myTasks.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No tasks currently assigned to you. Use get_full_briefing to check for available work.",
						},
					],
				};
			}

			const taskList = myTasks
				.map(
					(t) =>
						`- ${t.status === "claimed" ? "[CLAIMED] " : ""}${t.subject} (${t.id})`,
				)
				.join("\n");

			return {
				content: [
					{
						type: "text" as const,
						text: `You have ${myTasks.length} task(s):\n\n${taskList}`,
					},
				],
			};
		},
	);
}
