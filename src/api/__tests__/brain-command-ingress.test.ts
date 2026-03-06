import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  normalizeCommandEnvelope,
  validateAndRecordCommandEnvelope,
  validateCommandEnvelope,
} from "../brain-command-ingress";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      error TEXT
    )
  `);
  return db;
}

describe("brain-command-ingress", () => {
  it("normalizes bodies to command envelopes", () => {
    const envelope = normalizeCommandEnvelope({
      from: "arm-1",
      to: "brain",
      type: "status_update",
      payload: { taskId: "t1", status: "running" },
    });

    expect(envelope.id.length > 0).toBe(true);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.createdAt.length > 0).toBe(true);
  });

  it("validates brain-target payload contracts", () => {
    const envelope = normalizeCommandEnvelope({
      id: "cmd-invalid-payload",
      from: "arm-2",
      to: "brain",
      type: "status_update",
      payload: { taskId: "t2" },
    });

    expect(validateCommandEnvelope(envelope)).toContain("status_update requires payload.status");
  });

  it("records invalid envelopes in dead-letter storage", () => {
    const db = createDb();
    const envelope = normalizeCommandEnvelope({
      id: "cmd-invalid-type",
      from: "arm-3",
      to: "brain",
      type: "claim_transfer",
      payload: { filePath: "src/a.ts" },
    });

    const error = validateAndRecordCommandEnvelope(db, envelope, "api_publish");
    expect(error).toContain("unsupported brain message type");

    const row = db
      .query("SELECT to_id, message_type, status, error FROM messages LIMIT 1")
      .get() as { to_id: string; message_type: string; status: string; error: string } | null;
    expect(row).toBeTruthy();
    expect(row?.to_id).toBe("brain.deadletter");
    expect(row?.message_type).toBe("claim_transfer");
    expect(row?.status).toBe("failed");
  });
});
