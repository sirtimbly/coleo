import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { loadApiConfig, type ApiConfig } from "../config";
import { createApp } from "../server";

describe("API-only server", () => {
  let db: Database;
  let webDist: string;
  let config: ApiConfig;
  let previous: { enabled: string | undefined; dist: string | undefined };

  beforeEach(async () => {
    previous = { enabled: process.env.COLEO_SERVE_WEB, dist: process.env.COLEO_WEB_DIST };
    delete process.env.COLEO_SERVE_WEB;
    delete process.env.COLEO_WEB_DIST;
    webDist = await mkdtemp(join(tmpdir(), "coleo-web-dist-"));
    await mkdir(join(webDist, "assets"));
    await writeFile(join(webDist, "assets", "app-deadbeef.js"), "export const ready = true;");
    await writeFile(join(webDist, "index.html"), "<!doctype html><title>Coleo</title>");

    db = new Database(":memory:");
    config = {
      ...loadApiConfig(),
      apiKey: "test-static-assets-key",
      corsOrigins: ["http://localhost:5173"],
    };
  });

  afterEach(async () => {
    if (previous.enabled === undefined) delete process.env.COLEO_SERVE_WEB;
    else process.env.COLEO_SERVE_WEB = previous.enabled;
    if (previous.dist === undefined) delete process.env.COLEO_WEB_DIST;
    else process.env.COLEO_WEB_DIST = previous.dist;
    db.close();
    await rm(webDist, { recursive: true, force: true });
  });

  for (const legacyHostingEnabled of [false, true]) {
    it(`does not serve UI routes or assets with legacy hosting ${legacyHostingEnabled ? "enabled" : "unset"}`, async () => {
      if (legacyHostingEnabled) {
        process.env.COLEO_SERVE_WEB = "1";
        process.env.COLEO_WEB_DIST = webDist;
      }
      const app = createApp(db, config);

      for (const pathname of ["/", "/workspaces/current", "/tasks/example", "/index.html", "/assets/app-deadbeef.js"]) {
        const response = await app.request(pathname, { headers: { Accept: "text/html" } });

        expect(response.status).toBe(404);
        expect(response.headers.get("Content-Type")).not.toContain("text/html");
        expect(await response.text()).toBe("404 Not Found");
      }

      const health = await app.request("/api/health");
      expect(health.status).toBe(200);
      expect(health.headers.get("Content-Type")).toContain("application/json");
    });
  }

  it("keeps CORS enabled for API routes", async () => {
    const app = createApp(db, config);
    const response = await app.request(new Request("http://localhost/api/health", {
      headers: { Origin: "http://localhost:5173" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
});
