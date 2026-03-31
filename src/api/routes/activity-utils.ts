/**
 * Activity utilities
 *
 * Helper functions for parsing, filtering, and formatting activity data.
 */

import { basename } from "path";
import type { EventData } from "../../nats/jetstream";
import type { ArmMetadata } from "./activity-types";

/**
 * Parse a limit query parameter with bounds checking
 */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = parseInt(raw || String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

/**
 * Parse a date query parameter with validation
 */
export function parseDateQuery(raw: string | undefined): { value?: Date; error?: string } {
  if (!raw) {
    return {};
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `Invalid date: ${raw}` };
  }

  return { value: parsed };
}

/**
 * Parse an optional positive integer with fallback
 */
export function parseOptionalPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

/**
 * Parse a comma-separated list of IDs, removing duplicates
 */
export function parseIdList(...rawValues: Array<string | undefined>): string[] {
  const values: string[] = [];
  for (const raw of rawValues) {
    if (!raw) {
      continue;
    }

    for (const token of raw.split(",")) {
      const id = token.trim();
      if (id.length > 0) {
        values.push(id);
      }
    }
  }

  return Array.from(new Set(values));
}

/**
 * Extract workdir from arm config JSON
 */
export function parseWorkdir(configText: string | null): string | null {
  if (!configText) {
    return null;
  }

  try {
    const parsed = JSON.parse(configText) as Record<string, unknown>;
    const workdir = parsed.workdir;
    return typeof workdir === "string" && workdir.trim().length > 0 ? workdir : null;
  } catch {
    return null;
  }
}

/**
 * Derive project name from workdir path
 */
export function deriveProject(workdir: string | null): string | null {
  if (!workdir) {
    return null;
  }

  const normalized = workdir.replace(/\\/g, "/").replace(/\/+$/, "");
  const project = basename(normalized);
  return project.length > 0 ? project : null;
}

/**
 * Check if metadata matches a project filter
 */
export function matchesProjectFilter(projectFilter: string, metadata: ArmMetadata | undefined): boolean {
  if (!metadata) {
    return false;
  }

  const filter = projectFilter.toLowerCase();
  const project = metadata.project?.toLowerCase();
  const workdir = metadata.workdir?.toLowerCase();

  if (project === filter) {
    return true;
  }

  if (!workdir) {
    return false;
  }

  if (workdir === filter) {
    return true;
  }

  return workdir.includes(`/${filter}/`);
}

/**
 * Serialize a value for CSV/text output
 */
export function serializeValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    return values.length > 0 ? values.join(" ") : null;
  }
  return null;
}

/**
 * Build transcript text from event details
 */
export function buildTranscriptText(eventType: string, details: Record<string, unknown>): string {
  const preferredKeys = [
    "message",
    "prompt",
    "content",
    "text",
    "summary",
    "error",
    "reason",
    "title",
  ];

  const textParts: string[] = [];
  for (const key of preferredKeys) {
    const value = serializeValue(details[key]);
    if (value) {
      textParts.push(value);
    }
  }

  let body = textParts.join(" ").trim();
  if (!body) {
    body = JSON.stringify(details);
  }

  const combined = `${eventType} ${body}`.trim();
  return combined.length > 4000 ? `${combined.slice(0, 4000)}...` : combined;
}

/**
 * Sort events by timestamp (oldest first), then by type
 */
export function sortEventsOldestFirst(a: { event: EventData }, b: { event: EventData }): number {
  const aTime = new Date(a.event.timestamp).getTime();
  const bTime = new Date(b.event.timestamp).getTime();

  if (aTime !== bTime) {
    return aTime - bTime;
  }

  return a.event.type.localeCompare(b.event.type);
}

/**
 * Normalize a value to an ISO timestamp
 */
export function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}
