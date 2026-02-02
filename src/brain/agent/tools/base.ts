/**
 * Brain Agent Tool Base
 */

import type { Database } from "bun:sqlite";

export interface ToolContext {
  db: Database;
  projectRoot: string;
  coleoDir: string;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export abstract class BrainTool {
  protected context: ToolContext;

  constructor(context: ToolContext) {
    this.context = context;
  }

  abstract name: string;
  abstract description: string;
  abstract inputSchema: Record<string, unknown>;

  abstract execute(input: Record<string, unknown>): Promise<ToolResult>;
}
