import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("retired commands report the client target without executing operations", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import { Command } from "commander";
    import { registerClientMigration } from ${JSON.stringify(new URL("../client-migration.ts", import.meta.url).pathname)};
    const program = new Command();
    registerClientMigration(program, "tasks", "tasks");
    await program.parseAsync(["tasks", "sync", "--force"], { from: "user" });
  `], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("coleo-client tasks");
  expect(stderr).toContain("COLEO_API_URL");
});

test("legacy entry point retires domain commands without creating local state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coleo-migration-"));
  try {
    for (const args of [["tasks", "sync"], ["mail", "send", "test"], ["arm", "kill", "test"], ["agent", "status"]]) {
      const child = Bun.spawn([process.execPath, new URL("../index.ts", import.meta.url).pathname, ...args], {
        cwd: directory, env: { ...process.env, COLEO_DIR: directory }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Use coleo-client");
    }
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
