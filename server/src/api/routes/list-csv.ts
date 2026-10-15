import { Hono } from "hono";
import { exportListToCsv, importListFromCsv } from "../../cli/list-csv";
import { HttpError } from "../middleware";
import type { Database } from "bun:sqlite";
import type { CsvListKind } from "../../cli/list-csv";

/** Share the original CLI's format and optimistic field conflict semantics. */
export function createListCsvRoutes(kind: CsvListKind): Hono<{ Variables: { db: Database } }> {
  const app = new Hono<{ Variables: { db: Database } }>();
  app.get("/export", (c) => {
    const filter = c.req.query("filter") ?? "all";
    if (filter !== "all" && filter !== "pending" && filter !== "not-completed") {
      throw HttpError.badRequest("filter must be all, pending, or not-completed");
    }
    return c.json({ schemaVersion: 1, kind: "module.csv.export", module: kind,
      csv: exportListToCsv(c.get("db"), kind, filter) });
  });
  app.post("/import", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw HttpError.badRequest("Expected JSON with a csv string");
    }
    if (!body || typeof body !== "object" || !("csv" in body) || typeof body.csv !== "string") {
      throw HttpError.badRequest("Expected JSON with a csv string");
    }
    // Parsing precedes all writes; malformed CSV must be a client error.
    let result;
    try {
      result = importListFromCsv(c.get("db"), kind, body.csv);
    } catch (error) {
      if (error instanceof Error && error.message === "CSV ended inside a quoted field") {
        throw HttpError.badRequest(error.message);
      }
      throw error;
    }
    return c.json({ schemaVersion: 1, kind: "module.csv.import", module: kind, ...result });
  });
  return app;
}
