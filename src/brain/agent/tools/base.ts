/**
 * Brain Agent Tool Base
 */

import type { BrainDb } from "../../db-client";
import type { WorkspaceAccess } from "../../../workspace";
import type { BrainEventPublisher } from "../../brain-api-client";

export interface ToolContext {
  db: BrainDb;
  projectRoot: string;
  coleoDir: string;
  workspace?: WorkspaceAccess;
  /**
   * API-boundary event publisher. When absent, tools skip event
   * publication (previous best-effort behavior without JetStream).
   */
  publishEvent?: BrainEventPublisher;
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
