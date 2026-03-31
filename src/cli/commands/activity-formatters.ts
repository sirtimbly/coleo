import type { ActivityListRow, TranscriptEntry, SearchResultRow } from "./activity-api";

export function normalizeActivityRow(entry: unknown, fallbackId: number): ActivityListRow | null {
  if (!isRecord(entry)) {
    return null;
  }

  const id = typeof entry.id === "number" ? entry.id : fallbackId;
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
  const actor = typeof entry.actor === "string" ? entry.actor : "unknown";
  const action = typeof entry.action === "string" ? entry.action : "unknown";
  const target = typeof entry.target === "string" ? entry.target : null;

  return {
    id,
    timestamp,
    actor,
    action,
    target,
    details: normalizeDetails(entry.details),
  };
}

export function normalizeTranscriptEntry(entry: unknown): TranscriptEntry | null {
  if (!isRecord(entry)) {
    return null;
  }

  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
  const armId = typeof entry.armId === "string" ? entry.armId : null;
  const action = typeof entry.action === "string" ? entry.action : "unknown";
  if (!timestamp || !armId) {
    return null;
  }

  const details = normalizeDetails(entry.details);
  const text = typeof entry.text === "string" && entry.text.length > 0
    ? entry.text
    : JSON.stringify(details);

  const partitionsRaw = isRecord(entry.partitions) ? entry.partitions : {};
  const partitions = {
    armId: typeof partitionsRaw.armId === "string" ? partitionsRaw.armId : armId,
    host: typeof partitionsRaw.host === "string" ? partitionsRaw.host : null,
    project: typeof partitionsRaw.project === "string" ? partitionsRaw.project : null,
    workdir: typeof partitionsRaw.workdir === "string" ? partitionsRaw.workdir : null,
  };

  return {
    timestamp,
    armId,
    action,
    text,
    details,
    partitions,
  };
}

export function normalizeSearchResult(entry: unknown): SearchResultRow | null {
  if (!isRecord(entry)) {
    return null;
  }

  const id = typeof entry.id === "string" ? entry.id : null;
  const score = typeof entry.score === "number" ? entry.score : null;
  const title = typeof entry.title === "string" ? entry.title : "";
  const content = typeof entry.content === "string" ? entry.content : "";
  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString();

  if (!id || score === null) {
    return null;
  }

  return {
    id,
    score,
    title,
    content,
    metadata: normalizeDetails(entry.metadata),
    createdAt,
  };
}

export function normalizeDetails(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  return {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asDetailString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

export function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseLimit(rawValue: unknown, fallback: number, max: number): number {
  if (typeof rawValue !== "string") {
    return fallback;
  }

  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

export function parseNumber(rawValue: unknown, fallback: number): number {
  if (typeof rawValue !== "string") {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}
