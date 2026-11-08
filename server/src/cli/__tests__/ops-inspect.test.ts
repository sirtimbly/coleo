import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverOpsWorkspace } from "../ops-workspace";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(): Promise<{ root: string; runtime: string; nested: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coleo-inspect-"))); directories.push(root);
  const runtime = join(root, ".coleo"); const nested = join(root, "src/deep");
  await mkdir(runtime); await mkdir(nested, { recursive: true });
  return { root, runtime, nested };
}
async function run(cwd: string, args: string[], overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("COLEO_") && !key.startsWith("OPENAI_")) env[key] = value;
  }
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../ops.ts"), ...args], {
    cwd, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output, error, code };
}
test("discovery chooses the nearest workspace and honors explicit selections", async () => {
  const { root, runtime, nested } = await fixture();
  expect(discoverOpsWorkspace({}, nested, {}).directory).toBe(runtime);
  expect(discoverOpsWorkspace({}, nested, {}).workspace).toBe(root);
  const inner = join(root, "src/.coleo"); await mkdir(inner);
  expect(discoverOpsWorkspace({}, nested, {}).directory).toBe(inner);
  expect(discoverOpsWorkspace({ dir: runtime }, nested, { COLEO_DIR: inner }).directory).toBe(runtime);
  expect(discoverOpsWorkspace({}, nested, { COLEO_DIR: runtime }).origin).toBe("environment:COLEO_DIR");
  expect(discoverOpsWorkspace({ workspace: nested }, nested, {}).directory).toBe(join(nested, ".coleo"));
});
test("root env points nested commands to a runtime outside the repository", async () => {
  const { root, nested } = await fixture();
  const external = join(root, "separate runtime");
  await mkdir(external);
  await writeFile(join(root, ".env"), `COLEO_DIR="${external}"\n`);
  expect(discoverOpsWorkspace({}, nested, {}).directory).toBe(external);
  expect(discoverOpsWorkspace({}, nested, {}).workspace).toBe(root);
});
test("init from a nested directory reuses its enclosing workspace", async () => {
  const { root, runtime, nested } = await fixture();
  const result = await run(nested, ["init", "--dry-run", "--json", "--clients", "cli"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.output).checks[0].detail).toContain(`workspace=${root};`);
  expect(JSON.parse(result.output).checks[0].detail).toContain(`runtime=${runtime};`);
  expect(await readdir(runtime)).toEqual([]);
});
test("doctor repairs an existing project's launch defaults and operators discover them from subdirectories", async () => {
  const { root, runtime, nested } = await fixture();
  const server = Bun.serve({ port: 0, fetch() {
    return Response.json({ schemaVersion: 1, generation: "fixture", ok: true,
      checks: [{ name: "database", status: "pass", checkedAt: new Date().toISOString(), detail: "Healthy" }] });
  } });
  try {
    await writeFile(join(runtime, "target.json"), JSON.stringify({ schemaVersion: 1, role: "client",
      server: server.url.origin, connection: "ge", webExecutable: join(runtime, "bin/coleo-web") }));
    const result = await run(nested, ["doctor", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).checks.find((check: { name: string }) => check.name === "project-defaults").detail).toContain("Repaired");
    expect(await readFile(join(root, ".env"), "utf8")).toContain('COLEO_CONNECTION="ge"');
    expect(await readFile(join(runtime, ".env"), "utf8")).toContain(`COLEO_PROJECT_DIR="${root}"`);
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../server.ts"), "status", "--json"], {
      cwd: nested, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text()).runtimeDirectory).toBe(runtime);
    const second = await run(nested, ["doctor", "--json"]);
    expect(JSON.parse(second.output).checks.find((check: { name: string }) => check.name === "project-defaults").detail).toBe("Project launch defaults are configured");
  } finally { await server.stop(true); }
});
test("init retains all client selections from an existing setup journal", async () => {
  const { root, runtime, nested } = await fixture();
  await writeFile(join(runtime, "setup.json"), JSON.stringify({ schemaVersion: 1, input: {
    schemaVersion: 1, role: "local", clients: ["cli", "tui", "web"], workspace: root, connection: "local",
  }, startedAt: new Date().toISOString(), steps: {} }));
  const result = await run(nested, ["init", "--dry-run", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.output).checks[0].detail).toContain("clients=cli,tui,web;");
});
test("init persists launch defaults before completing client setup", async () => {
  const { root, runtime, nested } = await fixture();
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "coleo-client"), '#!/bin/sh\nif [ "$1" = connections ]; then echo \'{"connections":[]}\'; fi\nexit 0\n', { mode: 0o755 });
  const server = Bun.serve({ port: 0, fetch() {
    return Response.json({ schemaVersion: 1, generation: "fixture", ok: true,
      checks: [{ name: "database", status: "pass", checkedAt: new Date().toISOString(), detail: "Healthy" }] });
  } });
  try {
    const result = await run(nested, ["init", "--non-interactive", "--role", "client", "--server", server.url.origin,
      "--connection", "ge", "--clients", "cli", "--json"], { PATH: `${bin}:${process.env.PATH}`, COLEO_API_KEY: "fixture-key" });
    expect(result.code).toBe(0);
    expect(await readFile(join(root, ".env"), "utf8")).toContain(`COLEO_DIR="${runtime}"`);
    expect(await readFile(join(runtime, ".env"), "utf8")).toContain('COLEO_CONNECTION="ge"');
  } finally { await server.stop(true); }
});
test("config shows provenance for flags, exported env, env files, saved values and defaults without credentials", async () => {
  const { root, runtime, nested } = await fixture();
  await writeFile(join(runtime, "operator.json"), JSON.stringify({ schemaVersion: 1, values: { maxArms: "3", apiKey: "saved-secret", port: "9000" } }));
  await writeFile(join(runtime, ".env"), "COLEO_API_PORT=9001\nCOLEO_API_KEY=file-secret\nCOLEO_NATS_TOKEN=broker-secret\n");
  const result = await run(nested, ["config", "show", "--show-origin", "--server", "https://chosen.example", "--json"], { COLEO_API_PORT: "9002" });
  expect(result.code).toBe(0);
  const entries = JSON.parse(result.output).entries as Array<{ name: string; value: string; origin: string }>;
  const setting = (name: string) => entries.find(entry => entry.name === name)!;
  expect(setting("runtime")).toEqual({ name: "runtime", value: runtime, origin: "discovered" });
  expect(setting("workspace").value).toBe(root);
  expect(setting("apiUrl").origin).toBe("flag:--server");
  expect(setting("port")).toEqual({ name: "port", value: "9002", origin: "environment:COLEO_API_PORT" });
  expect(setting("apiKey")).toEqual({ name: "apiKey", value: "[redacted]", origin: `${runtime}/.env:COLEO_API_KEY` });
  expect(setting("maxArms").origin).toBe(`${runtime}/operator.json:values.maxArms`);
  expect(setting("heartbeatInterval").origin).toBe("default");
  for (const secret of ["saved-secret", "file-secret", "broker-secret"]) expect(result.output + result.error).not.toContain(secret);
  const human = await run(nested, ["config", "show", "--show-origin"]);
  expect(human.output).toContain(`[${runtime}/.env:COLEO_API_KEY]`);
  expect(human.output).not.toContain("file-secret");
});
test("project root env is found from a nested directory", async () => {
  const { root, nested } = await fixture();
  await writeFile(join(root, ".env"), "COLEO_API_PORT=9123\n");
  const result = await run(nested, ["config", "show", "--json"]);
  const port = JSON.parse(result.output).entries.find((entry: { name: string }) => entry.name === "port");
  expect(port.value).toBe("9123");
  expect(port.origin).toBe(`${root}/.env:COLEO_API_PORT`);
});
test("status, doctor, and config agree on environment overriding a saved target", async () => {
  const { runtime, nested } = await fixture();
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() {
    requests++;
    return Response.json({ schemaVersion: 1, generation: "fixture", ok: true,
      checks: [{ name: "database", status: "pass", checkedAt: new Date().toISOString(), detail: "Healthy" }] });
  } });
  try {
    await writeFile(join(runtime, "target.json"), JSON.stringify({ schemaVersion: 1, role: "client", server: "http://127.0.0.1:1" }));
    const env = { COLEO_API_URL: server.url.origin };
    const status = await run(nested, ["status", "--json"], env);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.output).server).toBe(server.url.origin);
    expect(JSON.parse(status.output).services).toEqual([]);
    expect(JSON.parse(status.output).serverOrigin).toBe("environment:COLEO_API_URL");
    const doctor = await run(nested, ["doctor", "--json"], env);
    expect(doctor.code).toBe(0);
    const config = await run(nested, ["config", "show", "--json"], env);
    expect(JSON.parse(config.output).entries.find((entry: { name: string }) => entry.name === "apiUrl").value).toBe(server.url.origin);
    expect(requests).toBe(2); // Configuration inspection never connects.
  } finally { await server.stop(true); }
});
test("status without initialized state does not create files or query the default API", async () => {
  const { root, runtime } = await fixture();
  await rm(runtime, { recursive: true });
  const before = await readdir(root);
  const result = await run(root, ["status", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.output).initialized).toBe(false);
  expect(JSON.parse(result.output).checks).toEqual([]);
  expect(JSON.parse(result.output).nextCommand).toContain("init");
  expect(await readdir(root)).toEqual(before);
});
test("unreachable central API produces a concise actionable status", async () => {
  const { runtime, nested } = await fixture();
  await writeFile(join(runtime, "target.json"), JSON.stringify({ schemaVersion: 1, role: "client", server: "http://127.0.0.1:1" }));
  const result = await run(nested, ["status"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("Needs attention");
  expect(result.output).toContain("central_api");
  expect(result.output).toContain("doctor --wait");
  expect(result.output.split("\n").length).toBeLessThan(15);
});
