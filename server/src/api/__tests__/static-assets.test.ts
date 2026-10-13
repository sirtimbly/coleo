import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { loadApiConfig, type ApiConfig } from "../config";
import { createApp } from "../server";

describe("static web assets", () => {
  let db: Database;
  let webDist: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    webDist = await mkdtemp(join(tmpdir(), "coleo-web-dist-"));
    await mkdir(join(webDist, "assets"));
    await writeFile(join(webDist, "assets", "app-deadbeef.js"), "export const ready = true;");
    await writeFile(join(webDist, "index.html"), "<!doctype html><title>Coleo</title>");

    db = new Database(":memory:");
    const config: ApiConfig = {
      ...loadApiConfig(),
      apiKey: "test-static-assets-key",
      corsOrigins: ["http://localhost:5173"],
    };
    app = createApp(db, config, { webDist });
  });

  afterEach(async () => {
    db.close();
    await rm(webDist, { recursive: true, force: true });
  });

  it("serves JavaScript with an explicit MIME type and immutable caching", async () => {
    const response = await app.request(new Request("http://localhost/assets/app-deadbeef.js", {
      headers: { Origin: "http://localhost:5173" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript;charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.text()).toBe("export const ready = true;");
  });

  it("serves SPA fallbacks as uncached HTML", async () => {
    const response = await app.request("http://localhost/workspaces/current");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html;charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("keeps CORS enabled for API routes", async () => {
    const response = await app.request(new Request("http://localhost/api/health", {
      headers: { Origin: "http://localhost:5173" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
});
