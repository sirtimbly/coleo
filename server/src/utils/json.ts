/**
 * Safe JSON parsing utilities.
 * These helpers keep JSON.parse at the boundary and expose validated
 * values to the rest of the codebase.
 */

import type { BrainState } from "../db/state";

export interface SafeParseSuccess<T> {
  success: true;
  data: T;
}

export interface SafeParseFailure {
  success: false;
  error: string;
}

export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseFailure;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function safeJsonParse(text: string): SafeParseResult<unknown>;
export function safeJsonParse<T>(
  text: string,
  validator: (data: unknown) => data is T,
): SafeParseResult<T>;
export function safeJsonParse<T>(
  text: string,
  validator?: (data: unknown) => data is T,
): SafeParseResult<T | unknown> {
  try {
    const data: unknown = JSON.parse(text);
    if (validator && !validator(data)) {
      return {
        success: false,
        error: "JSON data failed validation",
      };
    }

    return { success: true, data };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown JSON parsing error",
    };
  }
}

export function safeJsonParseWithValidation<T>(
  text: string,
  validator: (data: unknown) => data is T,
): SafeParseResult<T> {
  return safeJsonParse(text, validator);
}

/**
 * Type guard for BrainState.
 * Accepts partial state objects because persisted state can be sparsely populated.
 */
export function isBrainState(data: unknown): data is Partial<BrainState> {
  if (!isRecord(data)) {
    return false;
  }

  if (data.status !== undefined && typeof data.status !== "string") {
    return false;
  }

  if (data.pollIntervalMs !== undefined && typeof data.pollIntervalMs !== "number") {
    return false;
  }

  if (data.startedAt !== undefined && typeof data.startedAt !== "string") {
    return false;
  }

  if (data.lastPollAt !== undefined && typeof data.lastPollAt !== "string") {
    return false;
  }

  if (data.pendingTasks !== undefined && typeof data.pendingTasks !== "number") {
    return false;
  }

  if (data.completedToday !== undefined && typeof data.completedToday !== "number") {
    return false;
  }

  if (data.completedTaskCount !== undefined && typeof data.completedTaskCount !== "number") {
    return false;
  }

  return true;
}
