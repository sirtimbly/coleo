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
      
      let query = `
        SELECT id, kind, title, details, severity, file_path
        FROM discoveries
        WHERE status = 'open'
      `;
      
      const params: string[] = [];
      
      if (input.severity && input.severity.length > 0) {
        query += ` AND severity IN (${input.severity.map(() => "?").join(",")})`;
        params.push(...input.severity);
      }
      
      query += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit.toString());
      
      const results = this.context.db.query(query).all(...params) as Array<{
        id: string;
        kind: string;
        title: string;
        details: string;
        severity: string;
        file_path: string | null;
      }>;
      
      const discoveries: DiscoveryItem[] = results.map(r => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        details: r.details,
        severity: r.severity,
        filePath: r.file_path || undefined,
      }));
      
      return { success: true, data: discoveries };
    } catch (error) {
      return { success: false, error: `Failed to get discoveries: ${error}` };
    }
  }
}
