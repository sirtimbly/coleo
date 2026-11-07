import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { evaluateHealthRows, readOperatorHealth } from "../../api/operator-health";
import { initializeSetupRuntime } from "../setup-runtime";
import { checkCentralHealth } from "../ops-health";
import { validateSetupInput, opsDirectory, normalizeSetupClients, executable } from "../ops-setup";
import { SetupFailure } from "../ops-setup";
import { formatSetupFailure, formatSetupSuccess } from "../ops-output";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coleo-ops-test-")); directories.push(directory); return directory;
}
test("operator resolution honors PATH unless a prefix is explicitly selected", async () => {
  const root = await temporary();
  const pathBin = join(root, "linked");
  const prefix = join(root, "installed");
  await mkdir(pathBin, { recursive: true });
  await mkdir(join(prefix, "bin"), { recursive: true });
  for (const bin of [pathBin, join(prefix, "bin")]) {
    await writeFile(join(bin, "coleo-server"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const original = process.env.PATH;
  try {
    process.env.PATH = pathBin;
    expect(executable("coleo-server", { timeout: 180 })).toBe(join(pathBin, "coleo-server"));
    expect(executable("coleo-server", { timeout: 180, prefix })).toBe(join(prefix, "bin/coleo-server"));
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
});
test("runtime defaults to the selected workspace, with explicit directory overrides", () => {
  const original = process.env.COLEO_DIR;
  delete process.env.COLEO_DIR;
  try {
    expect(opsDirectory({ timeout: 180 })).toBe(join(process.cwd(), ".coleo"));
    expect(opsDirectory({ timeout: 180, workspace: "/projects/other" })).toBe("/projects/other/.coleo");
    process.env.COLEO_DIR = "/runtime/environment";
    expect(opsDirectory({ timeout: 180, workspace: "/projects/other" })).toBe("/runtime/environment");
    expect(opsDirectory({ timeout: 180, dir: "/runtime/explicit" })).toBe("/runtime/explicit");
  } finally {
    if (original === undefined) delete process.env.COLEO_DIR;
    else process.env.COLEO_DIR = original;
  }
});
test("health inventory includes missing, stale and optional-but-enabled failures", () => {
  const now = Date.now();
  const checks = evaluateHealthRows([
    { component: "database", healthy: 1, optional: 0, error: null, last_check: new Date(now - 600_000).toISOString() },
    { component: "custom_integration", healthy: 0, optional: 1, error: "offline", last_check: new Date(now).toISOString() },
  ], now - 1000, now);
  expect(checks.find(check => check.name === "database")?.status).toBe("unknown");
  expect(checks.find(check => check.name === "custom_integration")?.status).toBe("fail");
  expect(checks.find(check => check.name === "brain_model_api")?.status).toBe("unknown");
});

test("stale health preserves actionable planning errors instead of hiding the blocker", () => {
  const checks = evaluateHealthRows([{ component: "brain_planning_gate", healthy: 0, optional: 0,
    error: JSON.stringify({ detail: "No readable .project/plan.md file was found", nextStep: "Create a project plan" }),
    last_check: new Date(Date.now() - 600_000).toISOString() }], Date.now() - 1000);
  const planning = checks.find(check => check.name === "brain_planning_gate")!;
  expect(planning.status).toBe("unknown");
  expect(planning.detail).toContain("No readable .project/plan.md");
  expect(planning.detail).toContain("Create a project plan");
  expect(checks.find(check => check.name === "brain_model_api")?.detail).toContain("evaluates a project plan");
});
test("green records from a previous process cannot satisfy central readiness", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE brain_state (id INTEGER, status TEXT, started_at TEXT, last_poll_at TEXT); CREATE TABLE infrastructure_health (component TEXT, healthy INTEGER, optional INTEGER, error TEXT, last_check TEXT)");
    const old = new Date(Date.now() - 10_000).toISOString();
    db.query("INSERT INTO brain_state VALUES (1, 'running', ?, ?)").run(old, old);
    for (const name of ["database", "nats", "maildir", "api_server", "brain_model_api", "brain_planning_gate"]) {
      db.query("INSERT INTO infrastructure_health VALUES (?, 1, 0, NULL, ?)").run(name, old);
    }
    expect(readOperatorHealth(db, new Date()).ok).toBe(false);
    expect(readOperatorHealth(db, new Date(Date.now() - 20_000)).ok).toBe(true);
  } finally { db.close(); }
});
test("initialization preserves edited config and templates on rerun", async () => {
  const directory = await temporary();
  await initializeSetupRuntime(directory);
  const config = join(directory, "config.toml");
  const template = join(directory, "arms/default.toml");
  await writeFile(config, "# user config\nversion = 1\n");
  await writeFile(template, "# customized arm\n");
  await initializeSetupRuntime(directory);
  expect(await readFile(config, "utf8")).toContain("user config");
  expect(await readFile(template, "utf8")).toBe("# customized arm\n");
  expect((await stat(config)).mode & 0o777).toBe(0o600);
});
test("setup inputs reject secrets and credentials in server URLs", () => {
  const input = { schemaVersion: 1, role: "client", client: "cli", workspace: "/tmp", connection: "local", server: "https://example.com" };
  expect(() => validateSetupInput({ ...input, apiKey: "secret" })).toThrow("Unknown setup field");
  expect(() => validateSetupInput({ ...input, server: "https://user:secret@example.com" })).toThrow();
  expect(() => validateSetupInput({ ...input, role: "agent" })).toThrow("nats-url");
});
test("health wait requires consecutive green snapshots in the same generation", async () => {
  let requests = 0;
  let updates = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    expect(request.headers.get("X-API-Key")).toBe("test-key");
    requests++;
    return Response.json({ schemaVersion: 1, ok: true, generation: requests === 1 ? "old" : "new",
      checks: [{ name: "database", status: "pass", checkedAt: new Date().toISOString(), detail: "Healthy" }] });
  } });
  try {
    expect((await checkCentralHealth({ url: server.url.origin, key: "test-key", wait: true, timeout: 8,
      progress: () => { updates++; } })).ok).toBe(true);
    expect(requests).toBe(3);
    expect(updates).toBe(2); // Generation changes matter; refreshed timestamps do not.
  } finally { await server.stop(true); }
}, 10_000);
test("missing central health never falls back to unauthenticated liveness", async () => {
  const server = Bun.serve({ port: 0, fetch() { return new Response("missing", { status: 404 }); } });
  try {
    const result = await checkCentralHealth({ url: server.url.origin, key: "secret", timeout: 1, wait: true });
    expect(result.ok).toBe(false);
    expect(result.checks.some(check => check.name === "readiness_deadline")).toBe(true);
  } finally { await server.stop(true); }
});
test("health wait honors cancellation", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  expect(checkCentralHealth({ url: "http://127.0.0.1:1", key: "", timeout: 30, wait: true, signal: controller.signal })).rejects.toThrow("cancelled");
});
test("setup dry run has no writes; doctor alias and incompatible options are parsed", async () => {
  const directory = join(await temporary(), "not-created");
  const entry = resolve(import.meta.dir, "../ops.ts");
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, entry, "--dir", directory, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, COLEO_DIR: directory } });
    return { code: await child.exited, output: await new Response(child.stdout).text() };
  };
  const plan = await run(["init", "--dry-run", "--json", "--clients", "cli"]);
  expect(plan.code).toBe(0); expect(JSON.parse(plan.output).ok).toBe(true);
  const setupAlias = await run(["setup", "--dry-run", "--json", "--client", "cli"]);
  expect(setupAlias.code).toBe(0); expect(JSON.parse(setupAlias.output)).toEqual(JSON.parse(plan.output));
  expect(await Bun.file(join(directory, "setup.json")).exists()).toBe(false);
  const conflict = await run(["--doctor", "setup", "--non-interactive", "--json"]);
  expect(conflict.code).not.toBe(0);
  const alias = await run(["--doctor", "--role", "client", "--server", "http://127.0.0.1:1", "--json", "--timeout", "1"]);
  expect(alias.code).toBe(1); expect(JSON.parse(alias.output).checks[0].name).toBe("central_api");
});

test("local setup failure and resume preserve credentials and user files", async () => {
  const root = await temporary();
  const directory = join(root, "runtime");
  const prefix = join(root, "prefix");
  const bin = join(prefix, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["coleo-server", "coleo-agent", "opencode"]) {
    await writeFile(join(bin, name), `#!/bin/sh\ncase "$*" in\n*initialize*) exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dir, "../server.ts"))} "$@" ;;\nesac\nexit 0\n`, { mode: 0o755 });
  }
  await writeFile(join(bin, "coleo-client"), `#!/bin/sh
case "$1" in
connections) printf '{"connections":[]}' ;;
doctor) printf '{"schemaVersion":1,"checks":[{"name":"server","ok":false},{"name":"tui","available":true}]}'; exit 2 ;;
connect) read -r key; printf connected > ${JSON.stringify(join(root, "cli-connected"))}; printf '{"ok":true}' ;;
esac
`, { mode: 0o755 });
  let healthy = false;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const stored = JSON.parse(await readFile(join(directory, "operator.json"), "utf8"));
    if (request.headers.get("X-API-Key") !== stored.values.apiKey) return new Response("unauthorized", { status: 401 });
    if (new URL(request.url).pathname === "/api/status") return Response.json({ cwd: root });
    return Response.json({ schemaVersion: 1, ok: healthy, generation: "fixture",
      checks: [{ name: "brain_poll", status: healthy ? "pass" : "unknown", checkedAt: new Date().toISOString(), detail: "fixture readiness" }] });
  } });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("COLEO_") && !key.startsWith("OPENAI_")) env[key] = value;
  }
  env.PATH = bin;
  const run = async (resume = false) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../ops.ts"), "--dir", directory,
      "init", "--non-interactive", "--json", "--clients", "tui", "--workspace", root,
      "--server", server.url.origin, "--prefix", prefix, "--timeout", healthy ? "5" : "1", ...(resume ? ["--resume"] : [])],
      { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  try {
    const failed = await run();
    expect(failed.code).toBe(1);
    expect(await readFile(join(root, "cli-connected"), "utf8")).toBe("connected");
    expect(JSON.parse(await readFile(join(directory, "setup.json"), "utf8")).input.clients).toEqual(["cli", "tui"]);
    const first = JSON.parse(await readFile(join(directory, "operator.json"), "utf8"));
    expect(first.values.apiKey).toBeTruthy();
    expect(first.values.host).toBe("127.0.0.1");
    expect(first.values.natsUrl).toBeUndefined();
    expect(Number(first.values.natsPort)).toBeGreaterThanOrEqual(4222);
    expect(Number(first.values.natsHttpPort)).toBeGreaterThanOrEqual(8222);
    expect(first.values.port).toBe(String(server.port));
    expect(await readFile(join(directory, "setup.json"), "utf8")).not.toContain(first.values.apiKey);
    expect(failed.stdout + failed.stderr).not.toContain(first.values.apiKey);
    await writeFile(join(directory, "config.toml"), "# user change\nversion = 1\n");
    healthy = true;
    const resumed = await run(true);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout).ok).toBe(true);
    expect(JSON.parse(await readFile(join(directory, "operator.json"), "utf8")).values.apiKey).toBe(first.values.apiKey);
    expect(JSON.parse(await readFile(join(directory, "operator.json"), "utf8")).values.natsPort).toBe(first.values.natsPort);
    expect(await readFile(join(directory, "config.toml"), "utf8")).toContain("user change");
    expect(await Bun.file(join(directory, "setup.lock")).exists()).toBe(false);
  } finally { await server.stop(true); }
}, 15_000);

test("CLI is required and optional client choices are additive and deduplicated", () => {
  expect(normalizeSetupClients([])).toEqual(["cli"]);
  expect(normalizeSetupClients(["web", "tui", "web"])).toEqual(["cli", "tui", "web"]);
  expect(() => normalizeSetupClients(["none"])).toThrow("CLI is required");
  const base = { schemaVersion: 1, role: "local", workspace: "/project", connection: "local" };
  expect(validateSetupInput({ ...base, clients: ["web", "tui"] }).clients).toEqual(["cli", "tui", "web"]);
  expect(validateSetupInput({ ...base, client: "none" }).clients).toEqual(["cli"]);
  expect(validateSetupInput({ ...base, client: "web" }).clients).toEqual(["cli", "web"]);
});

test("component failure clearly reports incomplete setup without service commands", () => {
  const message = formatSetupFailure(new SetupFailure("Web host missing; installer is unavailable", {
    schemaVersion: 1, ok: false, checks: [], runtime: "/project/.coleo", steps: { components: "failed" },
    failedStep: "components", startedServices: [], nextCommands: ["coleo-ops init --resume", "coleo-ops init --resume"],
  }));
  expect(message).toContain("Setup incomplete.");
  expect(message).toContain("Stopped at: components");
  expect(message).toContain("Service startup was not reached.");
  expect(message.match(/coleo-ops init --resume/g)).toHaveLength(1);
  expect(message).not.toMatch(/doctor| logs| stop/);
});

test("successful setup has an explicit completion summary", () => {
  const message = formatSetupSuccess({ schemaVersion: 1, ok: true, checks: [], server: "http://localhost:8080",
    clients: ["cli", "tui"], runtime: "/project/.coleo", nextCommands: ["coleo-ops status"] });
  expect(message).toContain("Setup complete — central services are ready.");
  expect(message).toContain("Clients: cli, tui");
  expect(message).not.toContain("stop");
});
