import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAgentProgram, createServerProgram } from "../operator-program";
import { SETTINGS, ensureAgentId, resolveOperatorConfig, saveOperatorConfig } from "../operator-config";
import { getCliEntrypoint } from "../entrypoint";

let directory: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  environment = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "coleo-operator-"));
  for (const [env] of Object.values(SETTINGS)) delete process.env[env];
  delete process.env.COLEO_API_TOKEN;
  process.env.COLEO_DIR = directory;
});
afterEach(async () => { process.env = environment; await rm(directory, { recursive: true, force: true }); });
test("import-safe programs expose only host operations", () => {
  const expected = ["run", "start", "restart", "stop", "status", "logs", "configure", "doctor"];
  expect(createAgentProgram().commands.map(command => command.name())).toEqual(expected);
  expect(createServerProgram().commands.map(command => command.name())).toEqual([...expected.slice(0, 6), "brain", ...expected.slice(6)]);
  expect(getCliEntrypoint("agent")).toBe(resolve(import.meta.dir, "../agent.ts"));
  expect(getCliEntrypoint("server")).toBe(resolve(import.meta.dir, "../server.ts"));
});
test("operator processes resolve legacy MCP subprocesses to index rather than their own executable", () => {
  const argv = process.argv[1];
  const override = process.env.COLEO_CLI_ENTRYPOINT;
  delete process.env.COLEO_CLI_ENTRYPOINT;
  try {
    for (const name of ["server.ts", "agent.ts", "coleo-agent"]) {
      process.argv[1] = resolve(import.meta.dir, "..", name);
      expect(getCliEntrypoint()).toBe(resolve(import.meta.dir, "../index.ts"));
    }
  } finally {
    process.argv[1] = argv!;
    if (override !== undefined) process.env.COLEO_CLI_ENTRYPOINT = override;
  }
});
test("flags > environment > env-file > saved > defaults, with provenance", async () => {
  await saveOperatorConfig({ port: "8123", natsToken: "saved-secret" });
  expect((await resolveOperatorConfig()).values.port).toBe("8123");
  await writeFile(join(directory, ".env"), "COLEO_API_PORT=8124\n");
  let config = await resolveOperatorConfig();
  expect(config.values.port).toBe("8124"); expect(config.sources.port).toBe("env-file");
  process.env.COLEO_API_PORT = "8125";
  config = await resolveOperatorConfig({ port: "8126" });
  expect(config.values.port).toBe("8126"); expect(config.sources.port).toBe("flag");
  config = await resolveOperatorConfig();
  expect(config.values.port).toBe("8125"); expect(config.sources.port).toBe("environment");
  expect((await stat(join(directory, "operator.json"))).mode & 0o777).toBe(0o600);
});
test("invalid save preserves configuration and generated agent identity is stable", async () => {
  const first = await resolveOperatorConfig(); await ensureAgentId(first);
  const second = await resolveOperatorConfig(); await ensureAgentId(second);
  expect(second.values.id).toBe(first.values.id);
  const before = await readFile(join(directory, "operator.json"), "utf8");
  await expect(saveOperatorConfig({ natsUrl: "nats://user:secret@host" })).rejects.toThrow("credentials");
  expect(await readFile(join(directory, "operator.json"), "utf8")).toBe(before);
});
test("exported HTTP credential alias outranks env-file canonical key and saved credentials", async () => {
  await saveOperatorConfig({ apiKey: "saved-key" });
  await writeFile(join(directory, ".env"), "COLEO_API_KEY=file-key\nCOLEO_API_TOKEN=file-token\n");
  process.env.COLEO_API_TOKEN = "exported-token";
  const config = await resolveOperatorConfig();
  expect(config.values.apiKey).toBe("exported-token");
  expect(config.sources.apiKey).toBe("environment");
  process.env.COLEO_API_KEY = "exported-canonical";
  expect((await resolveOperatorConfig()).values.apiKey).toBe("exported-canonical");
  expect((await resolveOperatorConfig({ apiKey: "flag-key" })).values.apiKey).toBe("flag-key");
});
test("entrypoints support offline help/version/status and redacted JSON configuration", async () => {
  for (const role of ["server", "agent"] as const) {
    for (const args of [["--help"], ["--version"], ["status", "--json"], ["configure", "--json"]]) {
      const child = Bun.spawn([process.execPath, getCliEntrypoint(role), ...args], {
        env: { ...process.env, COLEO_API_KEY: "do-not-print-this", COLEO_NATS_TOKEN: "nor-this" }, stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).not.toContain("do-not-print-this"); expect(output).not.toContain("nor-this");
      if (args.includes("--json")) expect(JSON.parse(output).schemaVersion).toBe(1);
    }
  }
});
