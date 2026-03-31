/**
* Communication Tools
* 
* MCP tools for arm communication and coordination.
*/

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ARM_ID,
	ensureArmRegistered,
	logActivity,
	sendToBrain,
} from "../utils";

/**
* Register communication-related tools on the MCP server
*/
export function registerCommunicationTools(server: McpServer): void {
	// Heartbeat - update arm status and notify brain
	server.registerTool(
		"heartbeat",
		{
			description:
				"Send a heartbeat to update your status and notify the brain you're still active",
			inputSchema: {
				status: z
					.string()
					.optional()
					.describe("Current arm status (idle, busy, etc.)"),
				current_task: z
					.string()
					.optional()
					.describe("Current task being worked on"),
			},
		},
		async ({ status, current_task }) => {
			// Ensure arm is registered in database
			ensureArmRegistered();

			// Send heartbeat message to brain
			const messageId = await sendToBrain({
				from: ARM_ID,
				to: "brain",
				type: "heartbeat",
				payload: {
					status: status || "active",
					currentTask: current_task,
				},
			});

			logActivity(ARM_ID, "heartbeat", undefined, { status, messageId });

			return {
				content: [
					{
						type: "text" as const,
						text: `Heartbeat sent (message: ${messageId}). Status: ${status || "active"}`,
					},
				],
			};
		},
	);
}
