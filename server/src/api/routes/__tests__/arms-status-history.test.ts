import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { createArmsRoutes } from "../arms";
import * as pipeline from "../../../vector/indexing-pipeline";
import type { StatusHistoryEvent } from "../../../vector/status-history";

describe("arm status-history route", () => {
  let app: Hono;
  let searchSpy: ReturnType<typeof spyOn>;

  const event: StatusHistoryEvent = {
    id: "event-1",
    type: "status_report",
    timestamp: "2026-07-21T12:00:00.000Z",
    source: "arm-alpha",
    armId: "arm-alpha",
    title: "Migration blocked",
    content: "Database migration is blocked",
    metadata: {},
  };

  beforeEach(() => {
    searchSpy = spyOn(pipeline, "searchStatusHistory").mockImplementation(async () => [
      { id: event.id, score: 0.9, event },
    ]);
    app = new Hono();
    app.route("/api/arms", createArmsRoutes());
  });

  afterEach(() => {
    searchSpy.mockRestore();
  });

  it("returns filtered status history at the public arm endpoint", async () => {
    const res = await app.request(
      "/api/arms/arm-alpha/status-history?from=2026-07-01T00:00:00.000Z&to=2026-07-31T00:00:00.000Z&limit=5",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      armId: "arm-alpha",
      total: 1,
      events: [{ id: "event-1" }],
    });
    expect(searchSpy).toHaveBeenCalledWith("arm-alpha", {
      armId: "arm-alpha",
      limit: 5,
      since: new Date("2026-07-01T00:00:00.000Z"),
      until: new Date("2026-07-31T00:00:00.000Z"),
    });
  });

  it("rejects invalid date filters on arm status-history", async () => {
    const res = await app.request("/api/arms/arm-alpha/status-history?from=bad-date");
    expect(res.status).toBe(400);
  });

  it("caps status-history limit to 500 for arm endpoint", async () => {
    const res = await app.request("/api/arms/arm-alpha/status-history?limit=99999");
    expect(res.status).toBe(200);
    expect(searchSpy).toHaveBeenCalledWith("arm-alpha", {
      armId: "arm-alpha",
      limit: 500,
      since: undefined,
      until: undefined,
    });
  });
});
