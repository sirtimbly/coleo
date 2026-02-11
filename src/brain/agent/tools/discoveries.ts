/**
 * Discoveries Tool
 */

import { BrainTool } from "./base";
import type { ToolResult } from "./base";
import type { DiscoveryItem } from "../types";

export class GetDiscoveriesTool extends BrainTool {
  name = "getDiscoveries";
  description = "Query discoveries made by arms from the database";
  
  inputSchema = {
    type: "object",
    properties: {
      filePattern: { type: "string", description: "Filter by file path pattern" },
      severity: { type: "array", items: { type: "string" }, description: "Filter by severity levels" },
      limit: { type: "number", description: "Maximum number to return", default: 50 },
    },
    required: [],
  };

  async execute(input: { filePattern?: string; severity?: string[]; limit?: number }): Promise<ToolResult<DiscoveryItem[]>> {
    try {
      const limit = input.limit ?? 50;

      const results = this.context.db.listDiscoveries({
        status: "open",
        severities: input.severity,
        limit,
      });

      const filtered = input.filePattern
        ? results.filter((r) => (r.filePath || "").includes(input.filePattern!))
        : results;

      const discoveries: DiscoveryItem[] = filtered.map(r => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        details: r.details,
        severity: r.severity,
        filePath: r.filePath || undefined,
      }));
      
      return { success: true, data: discoveries };
    } catch (error) {
      return { success: false, error: `Failed to get discoveries: ${error}` };
    }
  }
}
