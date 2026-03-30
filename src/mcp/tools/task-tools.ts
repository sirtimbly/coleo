/**
 * Task Tools
 * 
 * MCP tools for task management: claiming, completing, and reporting on tasks.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ARM_ID,
	sendToBrain,
	logActivity,
	getPendingTasks,
	resolveTaskReferenceForTool,
	rememberRecentlyCompletedTask,
	clearRecentCompletedTaskExclusion,
} from "./utils";

/**
 * Register task-related tools on the MCP server
 */
export function registerTaskTools(server: McpServer): void {
	// Claim a task from the queue
	server.registerTool(
		"claim_task",
		{
			description:
				"Send an asynchronous claim request for a task. After calling, poll get_my_instructions to see the brain's assignment result.",
			inputSchema: {
				task_id: z.string().describe("The ID of the task to claim"),
			},
		},
		async ({ task_id }) => {
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
			console.error(
				`[MCP] claim_task called by ${ARM_ID} for task ${resolvedTaskId}`,
			);
			const messageId = await sendToBrain({
				from: ARM_ID,
				to: "brain",
				type: "task_assignment",
				payload: {
					action: "claim",
					taskId: resolvedTaskId,
				},
			});
			clearRecentCompletedTaskExclusion();

			logActivity(ARM_ID, "claim_task", resolvedTaskId, { messageId });
			console.error(`[MCP] claim_task completed, messageId: ${messageId}`);

			return {
				content: [
					{
						type: "text" as const,
						text: `${resolution.note ? `${resolution.note}\n\n` : ""}Task ${resolvedTaskId} claim request sent (message: ${messageId}). Brain will confirm assignment.`,
					},
				],
			};
		},
	);

	// Complete a task
	server.registerTool(
		"complete_task",
		{
			description:
				"Send an asynchronous completion report for a task with a summary. The brain processes it from the command queue.",
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
			console.error(
				`[MCP] complete_task called by ${ARM_ID} for task ${resolvedTaskId}`,
			);
			const messageId = await sendToBrain({
				from: ARM_ID,
				to: "brain",
				type: "task_complete",
				payload: {
					taskId: resolvedTaskId,
					summary,
					artifacts: artifacts || [],
				},
			});
			// Guard against queue-processing races: the immediate next briefing should
			// not return the same task (or its verify follow-up) to this same arm.
			rememberRecentlyCompletedTask(resolvedTaskId);

			logActivity(ARM_ID, "complete_task", resolvedTaskId, {
				messageId,
				artifactCount: (artifacts || []).length,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `${resolution.note ? `${resolution.note}\n\n` : ""}Task ${resolvedTaskId} marked complete. Summary sent to brain (message: ${messageId}).`,
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
			const reportId = `sr-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

			const messageId = await sendToBrain({
				from: ARM_ID,
				to: "brain",
				type: "status_report",
				payload: {
					id: reportId,
					taskId: resolvedTaskId,
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

			logActivity(ARM_ID, "submit_status_report", resolvedTaskId, {
				messageId,
				reportId,
				status,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `${resolution.note ? `${resolution.note}\n\n` : ""}Status report ${reportId} submitted for task ${resolvedTaskId} (message: ${messageId}).`,
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
			console.error(
				`[MCP] acknowledge_task called by ${ARM_ID} for task ${resolvedTaskId}`,
			);
			const messageId = await sendToBrain({
				from: ARM_ID,
				to: "brain",
				type: "task_acknowledge",
				payload: {
					taskId: resolvedTaskId,
					screenshotPath: screenshot_path,
				},
			});

			logActivity(ARM_ID, "acknowledge_task", resolvedTaskId, { messageId });

			return {
				content: [
					{
						type: "text" as const,
						text: `${resolution.note ? `${resolution.note}\n\n` : ""}Task ${resolvedTaskId} acknowledged (message: ${messageId}).`,
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
			console.error(
				`[MCP] validate_task called by ${ARM_ID} for task ${resolvedTaskId}`,
			);
			const messageId = await sendToBrain({
				from: ARM_ID,
				to: "brain",
				type: "task_validation",
				payload: {
					taskId: resolvedTaskId,
					approved,
					notes,
					screenshotPath: screenshot_path,
				},
			});

			logActivity(ARM_ID, "validate_task", resolvedTaskId, { messageId, approved });

			return {
				content: [
					{
						type: "text" as const,
						text: `${resolution.note ? `${resolution.note}\n\n` : ""}Task ${resolvedTaskId} validation submitted: ${approved ? "APPROVED" : "REJECTED"} (message: ${messageId}).`,
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
