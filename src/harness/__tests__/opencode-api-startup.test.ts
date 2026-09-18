import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { OpenCodeApiHarness } from "../opencode-api";
import { waitForOpenCodeServer } from "../opencode-startup";

describe("OpenCode spawn failure cleanup", () => {
  let directory: string;
  let originalPath: string | undefined;
  let harness: OpenCodeApiHarness;
  const constants = OpenCodeApiHarness as unknown as {
    SESSION_CREATE_TIMEOUT_MS: number;
    SESSION_PRUNE_TIMEOUT_MS: number;
  };
  const originalTimeout = constants.SESSION_CREATE_TIMEOUT_MS;
  const originalPruneTimeout = constants.SESSION_PRUNE_TIMEOUT_MS;
  const internals = () => harness as unknown as {
    sessions: Map<string, { serverProcess: Subprocess }>;
    waitForServer(url: string, timeout: number, child?: Subprocess): Promise<void>;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "coleo-opencode-startup-"));
    await mkdir(join(directory, "bin"));
    await writeFile(join(directory, "fake-opencode.ts"), `
      await Bun.write(process.env.TEST_PID_FILE!, String(process.pid));
      console.log("fake OpenCode startup output");
      Bun.serve({
        port: Number(process.argv[process.argv.indexOf("--port") + 1]),
        fetch(request) {
          const path = new URL(request.url).pathname;
          const mode = process.env.TEST_STARTUP_MODE;
          if (path === "/global/health") {
            if (mode === "health-hang") return new Promise(() => {});
            return Response.json({ healthy: true, version: "test" });
          }
          if (request.method === "POST") {
            if (mode === "session-hang") return new Promise(() => {});
            return Response.json(mode === "missing-session" ? {} : { id: "test-session" });
          }
          if (mode === "prune-hang") return new Promise(() => {});
          return Response.json([]);
        },
      });
    `);
    const executable = join(directory, "bin", "opencode");
    await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${join(directory, "fake-opencode.ts")}' "$@"\n`);
    await chmod(executable, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${join(directory, "bin")}:${originalPath}`;
    constants.SESSION_CREATE_TIMEOUT_MS = 80;
    constants.SESSION_PRUNE_TIMEOUT_MS = 80;
    harness = new OpenCodeApiHarness();
    internals().waitForServer = (url, _timeout, child) => waitForOpenCodeServer(url, 800, child);
  });

  afterEach(async () => {
    constants.SESSION_CREATE_TIMEOUT_MS = originalTimeout;
    constants.SESSION_PRUNE_TIMEOUT_MS = originalPruneTimeout;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    for (const session of internals().sessions.values()) {
      session.serverProcess.kill();
      await session.serverProcess.exited;
    }
    await rm(directory, { recursive: true, force: true });
  });

  const config = (mode: string) => ({
    workdir: directory,
    env: {
      COLEO_ARM_ID: "startup-test",
      COLEO_DIR: directory,
      TEST_PID_FILE: join(directory, "pid"),
      TEST_STARTUP_MODE: mode,
    },
    headless: true,
  });

  for (const [mode, error] of [
    ["health-hang", "failed to start within 800ms"],
    ["session-hang", "session.create for startup-test timed out after 80ms"],
    ["missing-session", "no session ID returned"],
  ] as const) {
    it(`reaps the child and clears session state after ${mode}`, async () => {
      await expect(harness.spawn(config(mode))).rejects.toThrow(error);
      const pid = Number(await readFile(join(directory, "pid"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(internals().sessions.size).toBe(0);
      // The same arm can be started again after the failed process is gone.
      await harness.spawn(config("healthy"));
      expect(internals().sessions.size).toBe(1);
    });
  }

  it("keeps a successfully created arm usable when stale-session pruning stalls", async () => {
    const started = Date.now();
    await harness.spawn(config("prune-hang"));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(internals().sessions.size).toBe(1);
    const session = [...internals().sessions.values()][0]!;
    expect(session.serverProcess.exitCode).toBeNull();
  });
});
