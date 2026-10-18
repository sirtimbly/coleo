import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "fs/promises";
import { join } from "path";
import { getPendingTasks, getSharedNotes, COLEO_DIR } from "./utils";

export function registerResources(server: McpServer): void {
	// List pending tasks
	server.registerResource(
		"List of tasks available to claim",
		"coleo://tasks/pending",
		{},
		async () => {
			const tasks = await getPendingTasks();
			return {
				contents: [
					{
						uri: "coleo://tasks/pending",
						mimeType: "application/json",
						text: JSON.stringify(tasks, null, 2),
					},
				],
			};
		},
	);

	// Get shared notes
	server.registerResource(
		"Shared knowledge base from all arms",
		"coleo://notes/shared",
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
		},
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
		},
	);
}
