import { Hono } from "hono";

import { HttpError } from "../middleware";

import type { Database } from "bun:sqlite";

type EntityType = "task" | "bug";
type Resolution = "hour" | "day" | "week";

interface StatusHistoryRow {
  entityId: string;
  status: string;
  changedAt: string;
}

interface StatusSeriesBucket {
  start: string;
  end: string;
  counts: Record<string, number>;
  total: number;
}

interface StatusSeriesContext {
  Variables: {
    db: Database;
  };
}

const ENTITY_STATUSES = {
  task: ["draft", "pending", "claimed", "in_progress", "blocked", "completing", "completed", "failed", "cancelled"],
  bug: ["open", "investigating", "fixing", "verifying", "resolved", "closed"],
} as const satisfies Record<EntityType, readonly string[]>;

const RESOLUTION_MS: Record<Resolution, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

const MAX_RANGE_MS: Record<Resolution, number> = {
  hour: 31 * 24 * 60 * 60 * 1000,
  day: 2 * 366 * 24 * 60 * 60 * 1000,
  week: 10 * 366 * 24 * 60 * 60 * 1000,
};

function timestampMs(value: string): number {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(normalized).getTime();
}

export function buildStatusSeries(
  statuses: readonly string[],
  histories: StatusHistoryRow[],
  start: Date,
  end: Date,
  resolution: Resolution,
): StatusSeriesBucket[] {
  const validStatuses = new Set(statuses);
  const sorted = histories
    .map((history) => ({ ...history, changedAtMs: timestampMs(history.changedAt) }))
    .filter((history) => Number.isFinite(history.changedAtMs) && history.changedAtMs <= end.getTime())
    .sort((left, right) => left.changedAtMs - right.changedAtMs);
  const currentByEntity = new Map<string, string>();
  const buckets: StatusSeriesBucket[] = [];
  const stepMs = RESOLUTION_MS[resolution];
  let historyIndex = 0;

  for (let bucketStart = start.getTime(); bucketStart < end.getTime(); bucketStart += stepMs) {
    const bucketEnd = Math.min(end.getTime(), bucketStart + stepMs);
    while (historyIndex < sorted.length && sorted[historyIndex]!.changedAtMs <= bucketEnd) {
      const history = sorted[historyIndex]!;
      if (validStatuses.has(history.status)) currentByEntity.set(history.entityId, history.status);
      historyIndex += 1;
    }

    const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<string, number>;
    for (const status of currentByEntity.values()) counts[status] = (counts[status] ?? 0) + 1;
    buckets.push({
      start: new Date(bucketStart).toISOString(),
      end: new Date(bucketEnd).toISOString(),
      counts,
      total: currentByEntity.size,
    });
  }

  return buckets;
}

export function createStatusSeriesRoutes() {
  const app = new Hono<StatusSeriesContext>();

  app.get("/", (c) => {
    const db = c.get("db");
    const entity = c.req.query("entity");
    const resolution = c.req.query("resolution") || "day";
    const startValue = c.req.query("start");
    const endValue = c.req.query("end");
    if (entity !== "task" && entity !== "bug") {
      throw HttpError.badRequest("entity must be task or bug");
    }
    if (resolution !== "hour" && resolution !== "day" && resolution !== "week") {
      throw HttpError.badRequest("resolution must be hour, day, or week");
    }
    if (!startValue || !endValue) {
      throw HttpError.badRequest("start and end are required ISO timestamps");
    }

    const start = new Date(startValue);
    const end = new Date(endValue);
    const rangeMs = end.getTime() - start.getTime();
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || rangeMs <= 0) {
      throw HttpError.badRequest("start and end must be valid dates with start before end");
    }
    if (rangeMs > MAX_RANGE_MS[resolution]) {
      throw HttpError.badRequest(`The selected ${resolution} range is too large`);
    }

    const activeEntityFilter = entity === "task"
      ? "EXISTS (SELECT 1 FROM tasks t WHERE t.id = h.entity_id)"
      : "EXISTS (SELECT 1 FROM bugs b WHERE b.id = h.entity_id AND COALESCE(b.archived, 0) = 0)";
    const histories = db.query(
      `SELECT h.entity_id as entityId, h.status, h.changed_at as changedAt
       FROM entity_status_history h
       WHERE h.entity_type = ? AND julianday(h.changed_at) <= julianday(?)
         AND ${activeEntityFilter}
       ORDER BY julianday(h.changed_at), h.id`,
    ).all(entity, end.toISOString()) as StatusHistoryRow[];
    const statuses = ENTITY_STATUSES[entity];
    const buckets = buildStatusSeries(statuses, histories, start, end, resolution);

    return c.json({
      entity,
      resolution,
      start: start.toISOString(),
      end: end.toISOString(),
      statuses,
      buckets,
    });
  });

  return app;
}
