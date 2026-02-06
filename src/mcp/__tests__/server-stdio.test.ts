/**
 * MCP Server Stdio Integration Tests
 *
 * Validates that the MCP server works over stdio the way spawned arms use it.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDatabase } from "../../db";
import { mkdir, rm, readdir, readFile } from "fs/promises";
import { join } from "path";
import { Database } from "bun:sqlite";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

class JsonRpcClient {
  private child: ReturnType<typeof Bun.spawn>;
  private buffer = "";
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private writer: WritableStreamDefaultWriter<Uint8Array> | null;
  private nodeWritable: { write: (data: string) => void; end?: () => void } | null;
  private pending = new Map<number, (value: JsonRpcMessage) => void>();
  private nextId = 1;
  private readLoop: Promise<void>;
  private stdoutLog = "";
  private stderrLog = "";
  private logLimit = 4000;

  constructor(child: ReturnType<typeof Bun.spawn>) {
    this.child = child;
    this.writer = null;
    this.nodeWritable = null;
    if (this.child.stdin) {
      const stdin = this.child.stdin as unknown as {
        getWriter?: () => WritableStreamDefaultWriter<Uint8Array>;
        write?: (data: string) => void;
        end?: () => void;
      };
      if (stdin.getWriter) {
        this.writer = stdin.getWriter();
      } else if (stdin.write) {
        this.nodeWritable = {
          write: stdin.write.bind(stdin),
          end: stdin.end?.bind(stdin),
        };
      }
    }
    this.readLoop = this.startReadLoop();
    this.startDrain(this.child.stderr);
  }

  private async startReadLoop(): Promise<void> {
    if (!this.child.stdout || typeof this.child.stdout === "number") return;
    const reader = this.child.stdout.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = this.decoder.decode(value, { stream: true });
      this.appendLog("stdout", chunk);
      this.buffer += chunk;
      this.processBuffer();
    }
  }

  private processBuffer(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.id !== undefined && this.pending.has(message.id)) {
          const resolve = this.pending.get(message.id);
          this.pending.delete(message.id);
          resolve?.(message);
        }
      } catch {
        // Ignore malformed JSON
      }
    }
  }

  private async startDrain(
    stream: ReadableStream<Uint8Array> | number | null | undefined
  ): Promise<void> {
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        this.appendLog("stderr", this.decoder.decode(value));
      }
    }
  }

  private appendLog(channel: "stdout" | "stderr", chunk: string): void {
    if (channel === "stdout") {
      this.stdoutLog = (this.stdoutLog + chunk).slice(-this.logLimit);
      return;
    }
    this.stderrLog = (this.stderrLog + chunk).slice(-this.logLimit);
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const payload: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    await this.writeLine(payload);
    const responsePromise = new Promise<JsonRpcMessage>((resolve) => {
      this.pending.set(id, resolve);
    });
    const timeoutMs = options?.timeoutMs ?? 8000;
    return Promise.race([
      responsePromise,
      new Promise<JsonRpcMessage>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `MCP request timed out after ${timeoutMs}ms\n` +
                `--- stderr ---\n${this.stderrLog || "(empty)"}\n` +
                `--- stdout ---\n${this.stdoutLog || "(empty)"}`
            )
          );
        }, timeoutMs);
      }),
    ]);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const payload: JsonRpcMessage = { jsonrpc: "2.0", method, params };
    await this.writeLine(payload);
  }

  private async writeLine(payload: JsonRpcMessage): Promise<void> {
    const message = JSON.stringify(payload) + "\n";
    if (this.nodeWritable) {
      this.nodeWritable.write(message);
      return;
    }
    if (!this.writer) return;
    await this.writer.write(this.encoder.encode(message));
  }

  async close(): Promise<void> {
    if (this.writer) {
      await this.writer.close();
    }
    this.nodeWritable?.end?.();
    this.child.kill();
    await this.readLoop;
  }
}

describe("MCP Server - Stdio Integration", () => {
  let testDir: string;
  let coleoDir: string;
  let dbPath: string;
  let client: JsonRpcClient | null = null;
  const armId = "arm-stdio-test";
  const testTimeoutMs = 15000;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-mcp-stdio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    coleoDir = join(testDir, ".coleo");
    dbPath = join(coleoDir, "coleo.db");

    await mkdir(coleoDir, { recursive: true });

    const db = await initDatabase(dbPath);
    db.close();
  });

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function startServer(): Promise<JsonRpcClient> {
    const child = Bun.spawn(
      ["bun", "run", "src/cli/index.ts", "mcp", "serve"],
      {
        cwd: process.cwd(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          COLEO_DIR: coleoDir,
          COLEO_ARM_ID: armId,
          COLEO_PROJECT_ROOT: testDir,
          COLEO_NATS_URL: "nats://127.0.0.1:65535",
          COLEO_MCP_SQLITE_FALLBACK: "1",
        },
      }
    );

    return new JsonRpcClient(child);
  }

  async function initializeHandshake(rpc: JsonRpcClient): Promise<void> {
    const initResponse = await rpc.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "coleo-test", version: "0.0.1" },
        capabilities: {},
      },
      { timeoutMs: 8000 }
    );

    expect(initResponse.error).toBeUndefined();
    expect(initResponse.result).toBeDefined();

    await rpc.notify("notifications/initialized");
  }

  async function getLatestBrainMessage(): Promise<{ type?: string; from?: string; to?: string; payload?: unknown } | null> {
    const db = new Database(dbPath, { readonly: true });
    const row = db.query(
      "SELECT message_type, from_id, to_id, payload FROM messages WHERE to_id = 'brain' ORDER BY created_at DESC LIMIT 1"
    ).get() as { message_type: string; from_id: string; to_id: string; payload: string } | null;
    db.close();

    if (row) {
      return {
        type: row.message_type,
        from: row.from_id,
        to: row.to_id,
        payload: JSON.parse(row.payload),
      };
    }

    const queueDir = join(coleoDir, "queue", "brain", "pending");
    try {
      const files = await readdir(queueDir);
      const jsonFiles = files.filter((file) => file.endsWith(".json"));
      if (jsonFiles.length === 0) return null;
      const latestFile = jsonFiles.sort().at(-1) as string;
      return JSON.parse(await readFile(join(queueDir, latestFile), "utf-8")) as {
        type?: string;
        from?: string;
        to?: string;
        payload?: unknown;
      };
    } catch {
      return null;
    }
  }

  it("handshakes and lists tools", async () => {
    client = await startServer();
    await initializeHandshake(client);

    const listResponse = await client.request("tools/list", undefined, { timeoutMs: 8000 });
    expect(listResponse.error).toBeUndefined();

    const result = listResponse.result as { tools: Array<{ name: string }> };
    const toolNames = result.tools.map((tool) => tool.name);
    expect(toolNames).toContain("heartbeat");
    expect(toolNames).toContain("get_my_instructions");
    expect(toolNames).toContain("claim_task");
    expect(toolNames).toContain("claim_file");
    expect(toolNames).toContain("share_note");
    expect(toolNames).toContain("check_conflicts");
  }, testTimeoutMs);

  it("sends heartbeat and enqueues message for the brain", async () => {
    client = await startServer();
    await initializeHandshake(client);

    const response = await client.request(
      "tools/call",
      {
      name: "heartbeat",
      arguments: { status: "idle", current_task: "Bootstrapping" },
      },
      { timeoutMs: 8000 }
    );

    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]?.text).toContain("Heartbeat sent");

    const db = new Database(dbPath, { readonly: true });
    const arm = db.query("SELECT id, harness, status FROM arms WHERE id = ?").get(armId) as
      | { id: string; harness: string; status: string }
      | null;
    expect(arm?.id).toBe(armId);
    expect(arm?.harness).toBe("manual");

    db.close();

    const message = await getLatestBrainMessage();
    expect(message?.type).toBe("heartbeat");
    expect(message?.from).toBe(armId);
    expect(message?.to).toBe("brain");
  }, testTimeoutMs);

  it("returns pending tasks for the arm", async () => {
    const db = new Database(dbPath);
    db.run(
      `INSERT INTO tasks (id, subject, description, status, priority, assigned_to)
       VALUES (?, ?, ?, ?, ?, ?)`
      , ["task-stdio-1", "Test Task", "Work to do", "pending", "high", null]
    );
    db.close();

    client = await startServer();
    await initializeHandshake(client);

    const response = await client.request(
      "tools/call",
      {
      name: "get_my_instructions",
      arguments: {},
      },
      { timeoutMs: 8000 }
    );

    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]?.text).toContain("Test Task");
  }, testTimeoutMs);

  it("claims a file and reports conflicts", async () => {
    client = await startServer();
    await initializeHandshake(client);

    await client.request(
      "tools/call",
      {
        name: "heartbeat",
        arguments: { status: "idle" },
      },
      { timeoutMs: 8000 }
    );

    const claimResponse = await client.request(
      "tools/call",
      {
        name: "claim_file",
        arguments: { file_path: "src/mcp/server.ts", claim_type: "write", reason: "Test" },
      },
      { timeoutMs: 8000 }
    );

    expect(claimResponse.error).toBeUndefined();

    const db = new Database(dbPath, { readonly: true });
    const claim = db.query(
      "SELECT arm_id, claim_type, released_at FROM claims WHERE file_path = ? AND released_at IS NULL"
    ).get("src/mcp/server.ts") as { arm_id: string; claim_type: string; released_at: string | null } | null;
    db.close();

    expect(claim?.arm_id).toBe(armId);
    expect(claim?.claim_type).toBe("write");
    expect(claim?.released_at).toBeNull();

    const conflictResponse = await client.request(
      "tools/call",
      {
        name: "check_conflicts",
        arguments: { file_path: "src/mcp/server.ts" },
      },
      { timeoutMs: 8000 }
    );

    expect(conflictResponse.error).toBeUndefined();
    const conflictResult = conflictResponse.result as { content: Array<{ type: string; text: string }> };
    expect(conflictResult.content[0]?.text).toContain("claimed by you");
  }, testTimeoutMs);

  it("shares a note via the brain queue", async () => {
    client = await startServer();
    await initializeHandshake(client);

    const response = await client.request(
      "tools/call",
      {
        name: "share_note",
        arguments: { title: "Test Note", content: "Hello", tags: ["mcp", "test"] },
      },
      { timeoutMs: 8000 }
    );

    expect(response.error).toBeUndefined();
    const message = await getLatestBrainMessage();
    expect(message?.type).toBe("share_note");
    expect(message?.from).toBe(armId);
    expect(message?.to).toBe("brain");
    const payload = message?.payload as { title?: string; content?: string; tags?: string[] } | undefined;
    expect(payload?.title).toBe("Test Note");
    expect(payload?.content).toBe("Hello");
    expect(payload?.tags).toEqual(["mcp", "test"]);
  }, testTimeoutMs);
});
