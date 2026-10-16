import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getLogFilePath, getPidFilePath, getServiceStatus, readServiceInfo, registerServiceProcess, restartService, startService, stopService } from "../index";

let directory: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  environment = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "coleo-owned space $literal-"));
  process.env.COLEO_DIR = directory;
  process.env.COLEO_AGENT_ENTRYPOINT = resolve(import.meta.dir, "fixtures/service.ts");
});
afterEach(async () => {
  await stopService("agent", { force: true, timeout: 100 }).catch(() => {});
  await stopService("web", { force: true, timeout: 100 }).catch(() => {});
  process.env = environment;
  await rm(directory, { recursive: true, force: true });
});
test("owned start/status/restart preserves literal argv and appends logs", async () => {
  const args = ["--workspace", "a path $(touch NEVER) ; & ' \"", "--id", "stable-agent"];
  const first = await startService("agent", { args, startupTimeout: 5000 });
  expect(first.running).toBe(true);
  expect((await startService("agent")).pid).toBe(first.pid);
  const second = await restartService("agent", { startupTimeout: 5000 });
  expect(second.pid).not.toBe(first.pid);
  expect((await getServiceStatus("agent")).running).toBe(true);
  const log = await readFile(getLogFilePath("agent"), "utf8");
  const records = log.split("\n").filter(line => line.startsWith("{" )).map(line => JSON.parse(line));
  expect(records).toEqual([{ argv: ["run", ...args] }, { argv: ["run", ...args] }]);
  expect((await stopService("agent")).running).toBe(false);
}, 15000);
test("stale PID pointing at test process never signals it", async () => {
  await mkdir(join(directory, "run"));
  await writeFile(getPidFilePath("agent"), JSON.stringify({ type: "agent", pid: process.pid, identity: "not the kernel identity" }));
  expect((await getServiceStatus("agent")).running).toBe(false);
  expect((await stopService("agent")).running).toBe(false);
});
test("failed readiness is not mistaken for running", async () => {
  await expect(startService("agent", { env: { FIXTURE_FAIL: "1" }, startupTimeout: 2000 })).rejects.toThrow("Failed to start");
  expect((await getServiceStatus("agent")).running).toBe(false);
});
test("failed stop prevents restart and preserves identity", async () => {
  const first = await startService("agent", { env: { FIXTURE_IGNORE_STOP: "1" }, startupTimeout: 5000 });
  await expect(restartService("agent", { timeout: 100 })).rejects.toThrow("did not stop");
  expect((await readServiceInfo("agent"))?.pid).toBe(first.pid);
});
test("an alive but unready owned child is rejected and cleaned up", async () => {
  await expect(startService("agent", {
    env: { FIXTURE_NO_READY: "1", FIXTURE_IGNORE_STOP: "1" }, startupTimeout: 200,
  })).rejects.toThrow("readiness timed out");
  const log = await readFile(getLogFilePath("agent"), "utf8");
  const pid = Number(log.match(/unready PID (\d+)/)?.[1]);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});
test("runtime directories have independent state and log paths", async () => {
  const first = await startService("agent", { startupTimeout: 5000 });
  process.env.COLEO_DIR = join(directory, "second");
  expect((await getServiceStatus("agent")).running).toBe(false);
  const second = await startService("agent", { startupTimeout: 5000 });
  expect(second.pid).not.toBe(first.pid);
  await stopService("agent");
  process.env.COLEO_DIR = directory;
  expect((await getServiceStatus("agent")).pid).toBe(first.pid);
});
test("web compatibility preserves address argv and web/API environment", async () => {
  process.env.COLEO_CLI_ENTRYPOINT = process.env.COLEO_AGENT_ENTRYPOINT;
  process.env.WEB_UI_PORT = "5188";
  process.env.WEB_UI_HOST = "127.0.0.1";
  process.env.COLEO_WEB_DIST = join(directory, "web assets");
  process.env.COLEO_API_URL = "http://127.0.0.1:12345";
  expect((await startService("web", { env: { FIXTURE_SERVICE: "web", FIXTURE_WEB_ENV: "1" } })).running).toBe(true);
  const records = (await readFile(getLogFilePath("web"), "utf8")).split("\n")
    .filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  expect(records).toEqual([
    { argv: ["web", "--port", "5188", "--host", "127.0.0.1"] },
    { webDist: process.env.COLEO_WEB_DIST, apiUrl: process.env.COLEO_API_URL },
  ]);
});
test("concurrent foreground callers cannot overwrite a live stale-record takeover", async () => {
  const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" }));
  try {
    await mkdir(join(directory, "run"));
    await writeFile(getPidFilePath("agent"), JSON.stringify({ type: "agent", pid: process.pid, identity: "stale" }));
    const results = await Promise.allSettled(children.map(child => registerServiceProcess("agent", child.pid)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    expect((await getServiceStatus("agent")).pid).toBe(children[winner]!.pid);
  } finally {
    for (const child of children) { child.kill("SIGKILL"); await child.exited; }
  }
});
test("stale stop cleanup preserves a replacement registered while removal waits", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  const lockPath = join(directory, "run/agent.registration.lock");
  let lock;
  try {
    await registerServiceProcess("brain", child.pid);
    const replacement = { ...await readServiceInfo("brain"), type: "agent" };
    await writeFile(getPidFilePath("agent"), JSON.stringify({ type: "agent", pid: process.pid, identity: "stale" }));
    lock = await open(lockPath, "wx");
    const stopping = stopService("agent");
    await Bun.sleep(100);
    // Emulate the registration writer already holding its dedicated lock.
    await writeFile(getPidFilePath("agent"), JSON.stringify(replacement));
    await lock.close(); lock = undefined; await unlink(lockPath);
    expect((await stopping).pid).toBe(child.pid);
    expect((await getServiceStatus("agent")).pid).toBe(child.pid);
    expect(child.exitCode).toBeNull();
  } finally {
    await lock?.close(); await unlink(lockPath).catch(() => {});
    child.kill("SIGKILL"); await child.exited;
  }
});
