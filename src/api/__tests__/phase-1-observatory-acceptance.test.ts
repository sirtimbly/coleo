import { describe, it, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../server";
import { initDatabase } from "../../db";
import { loadApiConfig, type ApiConfig } from "../config";

let db: Database;
let app: ReturnType<typeof createApp>;
let apiKey: string;

beforeAll(async () => {
  db = await initDatabase(":memory:");
  const baseConfig = loadApiConfig();
  
  // Use a production-style API key (not "dev-*") to ensure auth is enforced in tests
  // We explicitly set a non-dev key to test that auth middleware works correctly
  apiKey = "test-api-key-12345";
  const config: ApiConfig = { ...baseConfig, apiKey };
  
  app = createApp(db, config);
});

describe("Phase 1 Acceptance – API Health", () => {
  it("responds to GET /api/health with status 200 and ok payload", async () => {
    // Health endpoint should work without auth
    const res = await app.request(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("returns system status via GET /api/status with database counts", async () => {
    const res = await app.request(new Request("http://localhost/api/status", { 
      headers: { "X-API-Key": apiKey } 
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { 
      status: string; 
      arms: { total: number };
      activity: { last24h: number };
      infrastructure?: { indexer?: { running: boolean }; qdrant?: { healthy: boolean } };
    };
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("arms");
    expect(typeof body.arms.total).toBe("number");
    expect(body).toHaveProperty("activity");
    expect(body.infrastructure).toBeDefined();
    expect(body.infrastructure?.indexer).toBeDefined();
    expect(typeof body.infrastructure?.indexer?.running).toBe("boolean");
    expect(body.infrastructure?.qdrant).toBeDefined();
    expect(typeof body.infrastructure?.qdrant?.healthy).toBe("boolean");
  });
});

describe("Phase 1 Acceptance – Arm Listing", () => {
  it("lists arms via GET /api/arms with expected fields", async () => {
    const res = await app.request(new Request("http://localhost/api/arms", { 
      headers: { "X-API-Key": apiKey } 
    }));
    expect(res.status).toBe(200);
    
    // API returns { arms: [...] } not a bare array
    const body = (await res.json()) as { arms: Array<Record<string, unknown>> };
    expect(body).toHaveProperty("arms");
    expect(Array.isArray(body.arms)).toBe(true);
    
    // If there are arms, verify expected fields exist
    if (body.arms.length > 0) {
      const item = body.arms[0];
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("name");
      expect(item).toHaveProperty("status");
      // The field is lastActivityAt, not lastSeenAt
      expect(item).toHaveProperty("lastActivityAt");
    }
  });

  it("returns empty arms array when no arms exist", async () => {
    const res = await app.request(new Request("http://localhost/api/arms", { 
      headers: { "X-API-Key": apiKey } 
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { arms: Array<unknown> };
    expect(body.arms).toEqual([]);
  });
});

describe("Phase 1 Acceptance – Activity Timeline", () => {
  it("returns activity list via GET /api/activity", async () => {
    const res = await app.request(new Request("http://localhost/api/activity", { 
      headers: { "X-API-Key": apiKey } 
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: Array<unknown>; pagination?: unknown };
    expect(body).toHaveProperty("activity");
    expect(Array.isArray(body.activity)).toBe(true);
  });
});

describe("Phase 1 Acceptance – Authentication", () => {
  it("rejects requests without API key with 401", async () => {
    const res = await app.request(new Request("http://localhost/api/arms"));
    expect(res.status).toBe(401);
  });

  it("rejects requests with invalid API key with 401", async () => {
    const res = await app.request(new Request("http://localhost/api/arms", { 
      headers: { "X-API-Key": "invalid-key-12345" } 
    }));
    expect(res.status).toBe(401);
  });

  it("allows health endpoint without API key", async () => {
    const res = await app.request(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
  });
});
