/**
 * Brain Agent Tool Base
 */

import type { BrainDb } from "../../db-client";
import type { WorkspaceAccess } from "../../../workspace";

export interface ToolContext {
  db: BrainDb;
  projectRoot: string;
  coleoDir: string;
  workspace?: WorkspaceAccess;
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
