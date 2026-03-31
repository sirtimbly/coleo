/**
 * Activity types
 *
 * Type definitions for activity logging and transcripts.
 */

import type { Database } from "bun:sqlite";

/**
 * Hono context type for activity routes with Database variable
 */
export interface ActivityContext {
  Variables: {
    db: Database;
  };
}

/**
 * Single activity entry representing an arm action
 */
export interface ActivityEntry {
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

/**
 * Metadata about an arm for filtering and partitioning
 */
export interface ArmMetadata {
  id: string;
  host: string | null;
  workdir: string | null;
  project: string | null;
}

/**
 * Entry in the activity transcript with full context
 */
export interface TranscriptEntry {
  timestamp: string;
  armId: string;
  action: string;
  text: string;
  details: Record<string, unknown>;
  partitions: {
    armId: string;
    host: string | null;
    project: string | null;
    workdir: string | null;
  };
}
