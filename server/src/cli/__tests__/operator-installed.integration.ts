/** Opt-in: bun server/src/cli/__tests__/operator-installed.integration.ts
 * Requires built dist/{server,agent}.js and NATS_BIN or .coleo/bin/nats-server.
 * All processes, credentials, storage and network endpoints are disposable/owned.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "nats";
import { recordOwnedArm } from "../../agent/arm-recovery";

const root = resolve(import.meta.dir, "../../../..");
const binary = process.env.NATS_BIN || join(root, ".coleo/bin/nats-server");
if (!await Bun.file(binary).exists()) throw new Error(`Provide NATS_BIN (missing ${binary})`);
const directory = await mkdtemp(join(tmpdir(), "coleo installed lifecycle "));
const workspace = join(directory, "workspace $literal");
const agentWorkspace = join(workspace, "host space ; $literal");
const installation = join(directory, "installation");
const home = join(directory, "home");
const runtimes = { server: join(directory, "server-runtime"), agent: join(directory, "agent-runtime") };
const pids = new Set<number>();
let nats: ReturnType<typeof Bun.spawn> | undefined;
let qdrant: ReturnType<typeof Bun.serve> | undefined;
let unrelatedArm: ReturnType<typeof Bun.spawn> | undefined;
const token = crypto.randomUUID();
const key = crypto.randomUUID();
let environment: NodeJS.ProcessEnv | undefined;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port!;
  server.stop(true);
  return port;
}
async function cli(role: "server" | "agent", args: string[]): Promise<Record<string, unknown>> {
  assert.ok(environment, "Isolated environment must be initialized before launching an operator");
  const child = Bun.spawn([process.execPath, join(installation, "dist", `${role}.js`), "--dir", runtimes[role], "--json", ...args], {
    cwd: workspace, env: environment, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  assert.equal(code, 0, `${role} ${args.join(" ")}: ${stdout}\n${stderr}`);
  const result = JSON.parse(stdout);
  assert.equal(result.schemaVersion, 1);
  if (typeof result.pid === "number") pids.add(result.pid);
  console.log(`${role} ${args[0]}: ok${result.pid ? ` PID ${result.pid}` : ""}`);
  return result;
}
async function waitForAgent(apiUrl: string, id: string, maxArms: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const response = await fetch(`${apiUrl}/api/agents`, { headers: { "X-API-Key": key } });
    assert.equal(response.status, 200);
    const result = await response.json() as { agents: Array<{ agentId: string; maxArms: number }> };
    if (result.agents.some(agent => agent.agentId === id && agent.maxArms === maxArms)) return;
    await delay(100);
  }
  throw new Error("Owned API did not observe the configured agent identity/capacity");
}
try {
  for (const path of [workspace, agentWorkspace, home, installation, ...Object.values(runtimes)]) await mkdir(path, { recursive: true });
  await writeFile(join(workspace, ".env"), "# intentionally isolated\n");
  await cp(join(root, "dist"), join(installation, "dist"), { recursive: true });
  await cp(join(root, "templates"), join(installation, "templates"), { recursive: true });
  qdrant = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "owned unavailable-Qdrant fixture" }, { status: 503 }) });
  const natsPort = freePort();
  const apiPort = freePort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  environment = {
    PATH: process.env.PATH, HOME: home, TMPDIR: directory,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    COLEO_NATS_TOKEN: token, COLEO_API_KEY: key,
    COLEO_QDRANT_URL: `http://127.0.0.1:${qdrant.port}`,
    COLEO_TRANSCRIPT_INDEXER_AUTOSTART: "0", COLEO_TRANSCRIPT_INDEXER_RECONCILE_MS: "0",
    COLEO_PROJECT_DIR: workspace, NODE_ENV: "test",
  };
  nats = Bun.spawn([binary, "-a", "127.0.0.1", "-p", String(natsPort), "-js", "-sd", join(directory, "jetstream"), "--auth", token], {
    cwd: directory, env: environment, stdout: Bun.file(join(directory, "nats.log")), stderr: Bun.file(join(directory, "nats-error.log")),
  });
  for (let i = 0; ; i++) {
    try { const connection = await connect({ servers: natsUrl, token, timeout: 200, reconnect: false }); await connection.close(); break; }
    catch (error) { if (i >= 40) throw error; await delay(100); }
  }
  console.log(`Owned NATS ${nats.pid}, API port ${apiPort}; installation ${installation}`);
  await cli("server", ["configure", "--host", "127.0.0.1", "--port", String(freePort()), "--nats-url", natsUrl, "--api-url", apiUrl]);
  const server = await cli("server", ["start", "--port", String(apiPort)]);
  assert.equal(server.running, true);
  const health = await fetch(`${apiUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await cli("server", ["status"])).pid, server.pid);
  const configured = await cli("agent", ["configure", "--workspace", workspace, "--nats-url", natsUrl,
    "--max-arms", "3", "--heartbeat-interval", "200", "--api-url", apiUrl]);
  const id = (configured.values as Record<string, string>).id!;
  assert.ok(id);
  const foreignPort = freePort();
  const foreignScript = join(directory, "opencode-unrelated-fixture.ts");
  const foreignReady = join(directory, "foreign-ready");
  const foreignRequests = join(directory, "foreign-requests");
  await writeFile(foreignScript, `import { appendFile } from "node:fs/promises";
    Bun.serve({ hostname: "127.0.0.1", port: ${foreignPort}, async fetch(request) {
      await appendFile(${JSON.stringify(foreignRequests)}, request.url + "\\n");
      return Response.json([]);
    }});
    await Bun.write(${JSON.stringify(foreignReady)}, "ready");`);
  unrelatedArm = Bun.spawn([process.execPath, foreignScript, "--port", String(foreignPort)], {
    env: { ...environment, COLEO_DIR: join(directory, "foreign-runtime"), COLEO_ARM_ID: "foreign-arm", COLEO_AGENT_ID: "foreign-host" },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; !await Bun.file(foreignReady).exists(); i++) {
    assert.ok(i < 40, "Owned unrelated-arm fixture did not start"); await delay(100);
  }
  // A valid live launch record with a different owner in the same runtime must
  // not cause a network probe or adoption. No global process masking is used.
  await recordOwnedArm({ coleoDir: runtimes.agent, workspaceRoot: agentWorkspace, agentId: "foreign-host" },
    "foreign-arm", unrelatedArm.pid, foreignPort);
  const agent = await cli("agent", ["start", "--max-arms", "4", "--heartbeat-interval", "250", "--workspace", agentWorkspace]);
  assert.equal(agent.running, true);
  await waitForAgent(apiUrl, id, 4);
  assert.equal((await cli("agent", ["status"])).pid, agent.pid);
  const restartedAgent = await cli("agent", ["restart"]);
  assert.notEqual(restartedAgent.pid, agent.pid);
  await waitForAgent(apiUrl, id, 4);
  const agentLaunch = JSON.parse(await readFile(join(runtimes.agent, "run/agent.launch.json"), "utf8")).args as string[];
  for (const [flag, expected] of [["--id", id], ["--workspace", agentWorkspace], ["--nats-url", natsUrl], ["--max-arms", "4"], ["--heartbeat-interval", "250"]]) {
    assert.equal(agentLaunch[agentLaunch.indexOf(flag!) + 1], expected);
  }
  const restartedServer = await cli("server", ["restart"]);
  assert.notEqual(restartedServer.pid, server.pid);
  assert.equal((await fetch(`${apiUrl}/api/health`)).status, 200);
  await waitForAgent(apiUrl, id, 4);
  for (const role of ["agent", "server"] as const) {
    const info = JSON.parse(await readFile(join(runtimes[role], `run/${role}.pid`), "utf8"));
    assert.equal(await realpath(info.command[1]), await realpath(join(installation, "dist", `${role}.js`)));
    assert.equal(info.command[2], "run");
    const logs = await cli(role, ["logs", "--lines", "1000"]);
    assert.ok((logs.lines as string[]).filter(line => line.startsWith("=== ")).length >= 2);
    await cli(role, ["doctor"]);
    assert.equal((await cli(role, ["stop"])).running, false);
    assert.equal((await cli(role, ["status"])).running, false);
  }
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), `Owned PID ${pid} still alive`);
  assert.equal(await Bun.file(foreignRequests).exists(), false, "Agent probed an unrelated arm");
  assert.equal(unrelatedArm.exitCode, null, "Agent shutdown affected an unrelated arm");
  console.log("PASS: actual bundled API + authenticated JetStream NATS + ArmAgent lifecycle; stable ID, options, logs and cleanup verified. Qdrant intentionally unavailable.");
} catch (error) {
  for (const role of ["server", "agent"] as const) {
    const log = await readFile(join(runtimes[role], `run/${role}.log`), "utf8").catch(() => "");
    console.error(`${role} diagnostic tail:\n${log.slice(-12000).replaceAll(key, "[redacted]").replaceAll(token, "[redacted]")}`);
  }
  throw error;
} finally {
  // Only isolated PID files/owned handles are used for cleanup, including failed starts.
  for (const role of ["agent", "server"] as const) {
    if (environment) await cli(role, ["stop", "--force", "--timeout", "1000"]).catch(() => {});
  }
  if (nats) { nats.kill("SIGTERM"); await nats.exited; }
  if (unrelatedArm) { unrelatedArm.kill("SIGTERM"); await unrelatedArm.exited; }
  await qdrant?.stop(true);
  await rm(directory, { recursive: true, force: true });
}
