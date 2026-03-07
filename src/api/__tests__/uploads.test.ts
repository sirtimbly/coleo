import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { createUploadApiRoutes, createUploadContentRoutes } from "../routes/uploads";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE uploaded_media (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      access_token TEXT NOT NULL UNIQUE,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe("uploads API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;
  let tempDir: string;
  let originalColeoDir: string | undefined;

  beforeEach(async () => {
    db = createTestDb();
    tempDir = await mkdtemp(join(tmpdir(), "coleo-uploads-test-"));
    originalColeoDir = process.env.COLEO_DIR;
    process.env.COLEO_DIR = tempDir;

    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/uploads", createUploadApiRoutes());
    app.route("/uploads", createUploadContentRoutes());
  });

  afterEach(async () => {
    db.close();
    if (originalColeoDir === undefined) {
      delete process.env.COLEO_DIR;
    } else {
      process.env.COLEO_DIR = originalColeoDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("stores an uploaded image and serves it back through the signed content URL", async () => {
    const formData = new FormData();
    const fileContents = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    formData.append(
      "file",
      new File([fileContents], "screen.png", { type: "image/png" }),
    );

    const uploadResponse = await app.request("http://coleo.test/api/uploads/images", {
      method: "POST",
      body: formData,
    });

    expect(uploadResponse.status).toBe(201);
    const uploadBody = (await uploadResponse.json()) as {
      attachment: {
        uploadId: string;
        filename: string;
        mimeType: string;
        sizeBytes: number;
        contentUrl: string;
      };
    };

    expect(uploadBody.attachment.filename).toBe("screen.png");
    expect(uploadBody.attachment.mimeType).toBe("image/png");
    expect(uploadBody.attachment.contentUrl).toContain("/uploads/");
    expect(uploadBody.attachment.contentUrl).toContain("token=");

    const stored = db
      .query("SELECT storage_path, size_bytes FROM uploaded_media WHERE id = ?")
      .get(uploadBody.attachment.uploadId) as {
        storage_path: string;
        size_bytes: number;
      } | null;

    expect(stored).not.toBeNull();
    expect(stored?.size_bytes).toBe(fileContents.byteLength);
    const persisted = await readFile(stored!.storage_path);
    expect(Array.from(persisted)).toEqual(Array.from(fileContents));

    const contentPath = new URL(uploadBody.attachment.contentUrl).pathname +
      new URL(uploadBody.attachment.contentUrl).search;
    const contentResponse = await app.request(`http://coleo.test${contentPath}`);

    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers.get("content-type")).toBe("image/png");
    const servedBuffer = new Uint8Array(await contentResponse.arrayBuffer());
    expect(Array.from(servedBuffer)).toEqual(Array.from(fileContents));
  });
});
