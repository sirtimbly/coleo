import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createCommandEnvelope } from "../../nats/command-types";
import { projectCommandEnvelopeToMessages } from "../brain-message-bridge";

function createMessagesTable(db: Database): void {
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
      error TEXT,
      source TEXT,
      stream_name TEXT,
      stream_seq INTEGER,
      dedupe_id TEXT
    );
    CREATE UNIQUE INDEX idx_messages_dedupe_id ON messages(dedupe_id) WHERE dedupe_id IS NOT NULL;
  `);
}

describe("brain-message-bridge projector", () => {
  it("projects a valid envelope into pending messages", () => {
    const db = new Database(":memory:");
    createMessagesTable(db);

    const envelope = createCommandEnvelope({
      id: "cmd-valid-1",
      from: "arm-1",
      to: "brain",
      type: "status_update",
      payload: { taskId: "task-1", status: "in_progress" },
    });

    const inserted = projectCommandEnvelopeToMessages(db, envelope, {
      streamName: "coleo-commands",
      streamSeq: 12,
    });

    expect(inserted).toBe(true);

    const row = db.query(
      `SELECT to_id, message_type, status, source, stream_name, stream_seq, dedupe_id
       FROM messages WHERE id = ?`,
    ).get("cmd-valid-1") as {
      to_id: string;
      message_type: string;
      status: string;
      source: string;
      stream_name: string;
      stream_seq: number;
      dedupe_id: string;
    } | null;

    expect(row).toBeTruthy();
    expect(row?.to_id).toBe("brain");
    expect(row?.message_type).toBe("status_update");
    expect(row?.status).toBe("pending");
    expect(row?.source).toBe("jetstream");
    expect(row?.stream_name).toBe("coleo-commands");
    expect(row?.stream_seq).toBe(12);
    expect(row?.dedupe_id).toBe("cmd-valid-1");
  });

  it("deduplicates repeated deliveries by envelope id", () => {
    const db = new Database(":memory:");
    createMessagesTable(db);

    const envelope = createCommandEnvelope({
      id: "cmd-dup-1",
      from: "arm-2",
      to: "brain",
      type: "status_update",
      payload: { taskId: "task-2", status: "queued" },
    });

    const first = projectCommandEnvelopeToMessages(db, envelope, {
      streamName: "coleo-commands",
      streamSeq: 30,
    });
    const second = projectCommandEnvelopeToMessages(db, envelope, {
      streamName: "coleo-commands",
      streamSeq: 31,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    const countRow = db
      .query("SELECT COUNT(*) AS count FROM messages WHERE id = 'cmd-dup-1'")
      .get() as { count: number };
    expect(countRow.count).toBe(1);
  });

  it("dead-letters invalid envelopes through shared validation", () => {
    const db = new Database(":memory:");
    createMessagesTable(db);

    const envelope = createCommandEnvelope({
      id: "cmd-invalid-1",
      from: "arm-3",
      to: "brain",
      type: "claim_transfer",
      payload: { filePath: "src/brain/brain.ts" },
    });

    const inserted = projectCommandEnvelopeToMessages(db, envelope, {
      streamName: "coleo-commands",
      streamSeq: 44,
    });

    expect(inserted).toBe(false);

    const deadLetter = db.query(
      `SELECT to_id, status, message_type, error
       FROM messages
       WHERE to_id = 'brain.deadletter'
       LIMIT 1`,
    ).get() as {
      to_id: string;
      status: string;
      message_type: string;
      error: string;
    } | null;

    expect(deadLetter).toBeTruthy();
    expect(deadLetter?.status).toBe("failed");
    expect(deadLetter?.message_type).toBe("claim_transfer");
    expect(deadLetter?.error).toContain("unsupported brain message type");
  });
});
