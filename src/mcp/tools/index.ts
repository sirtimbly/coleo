/**
 * MCP Tool Definitions
 * 
 * This module exports all tool handlers for the MCP server.
 * Tools are organized by category for maintainability.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Import tool categories
import { registerTaskTools } from "./task-tools";
import { registerBugTools } from "./bug-tools";
import { registerReportingTools } from "./reporting-tools";
import { registerFileClaimTools } from "./file-claim-tools";
import { registerDocumentationTools } from "./documentation-tools";
import { registerCommunicationTools } from "./communication-tools";
import { registerContextTools } from "./context-tools";
import { registerPromptTools } from "./prompt-tools";
import { registerServiceTools } from "./service-tools";
import { registerDevServerTools } from "./dev-server-tools";

/**
 * Register all MCP tools on the server
 */
export function registerAllTools(server: McpServer): void {
	registerTaskTools(server);
	registerBugTools(server);
	registerReportingTools(server);
	registerFileClaimTools(server);
	registerDocumentationTools(server);
	registerCommunicationTools(server);
	registerContextTools(server);
	registerPromptTools(server);
	registerServiceTools(server);
	registerDevServerTools(server);
}
