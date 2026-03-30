import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase } from "../../db";
import { Maildir, initMaildir } from "../../mail";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const CLI_ENTRYPOINT = join(process.cwd(), "src/cli/index.ts");
const TEST_ENVS = ["COLEO_DIR", "COLEO_API_HOST", "COLEO_API_PORT", "COLEO_API_KEY", "COLEO_API_TOKEN"];

let workspaceDir = "";

function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  const proc = Bun.spawnSync([process.execPath, "run", CLI_ENTRYPOINT, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BUN_TEST: "1",
      COLEO_DIR: workspaceDir,
      COLEO_API_HOST: "127.0.0.1",
      COLEO_API_PORT: "65534",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

async function seedWorkspace(): Promise<void> {
  await mkdir(join(workspaceDir, "arms"), { recursive: true });
  await mkdir(join(workspaceDir, "state"), { recursive: true });
  await initMaildir(join(workspaceDir, "mail"));
  await writeFile(
    join(workspaceDir, "arms", "default.toml"),
    [
      "[arm]",
      'name = "default"',
      'domain = "development"',
      'harness = "opencode-api"',
      "",
      "[model]",
      'provider = "openai"',
      'model = "gpt-5.1-mini"',
      "",
    ].join("\n"),
    "utf8",
  );

  const db = await initDatabase(join(workspaceDir, "coleo.db"));
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
    ["task-done", "Done task", "Already complete", "completed", "high", now, now],
  );
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
    ["task-pending", "Pending task", "Waiting to start", "pending", "normal", now, now],
  );
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
    ["task-active", "Active task", "Currently in progress", "in_progress", "high", now, now],
  );
  db.close();

  const inbox = new Maildir(join(workspaceDir, "mail", "inbox"));
  await inbox.write({
    from: "brain@coleo.local",
    to: "human@local",
    subject: "Status update",
    body: "The CLI pass is underway.",
    date: new Date(),
    headers: {},
  });
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "coleo-cli-"));
  await seedWorkspace();
});

afterEach(async () => {
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }

  workspaceDir = "";
  for (const key of TEST_ENVS) {
    delete process.env[key];
  }
});

describe("CLI workflows", () => {
  it("lists configured arms from the local workspace", () => {
    const result = runCli(["config", "arms"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Arm Configurations:");
    expect(result.stdout).toContain("default [development]");
  }, 20000);

  it("lists tasks as JSON in terminal-friendly priority order", () => {
    const result = runCli(["tasks", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const rows = JSON.parse(result.stdout) as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(["task-active", "task-pending", "task-done"]);
  }, 20000);

  it("shows inbox summaries and reads the newest message", async () => {
    const inboxResult = runCli(["mail", "inbox"]);
    expect(inboxResult.exitCode).toBe(0);
    expect(inboxResult.stdout).toContain("Inbox:");
    expect(inboxResult.stdout).toContain("Status update");

    const readResult = runCli(["mail", "read"]);
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout).toContain("Subject: Status update");
    expect(readResult.stdout).toContain("The CLI pass is underway.");

    const inbox = new Maildir(join(workspaceDir, "mail", "inbox"));
    const unread = await inbox.list("new");
    expect(unread).toHaveLength(0);
  }, 20000);

  it("reports useful fallback status details without the API server", () => {
    const result = runCli(["status"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("API Server: not running");
    expect(result.stdout).toContain("Brain: not started");
    expect(result.stdout).toContain("Inbox: 1 unread");
    expect(result.stdout).toContain("Tasks: 1 pending, 1 in progress");
  }, 20000);
});
