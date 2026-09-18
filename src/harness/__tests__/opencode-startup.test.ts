import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { stopFailedOpenCodeProcess, waitForOpenCodeServer, withStartupTimeout } from "../opencode-startup";

describe("OpenCode startup requests", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  it("aborts a request even when its operation never settles", async () => {
    let requestSignal: AbortSignal | undefined;
    await expect(withStartupTimeout((signal) => {
      requestSignal = signal;
      return new Promise(() => {});
    }, 30, "test request")).rejects.toThrow("test request timed out after 30ms");
    expect(requestSignal?.aborted).toBe(true);
  });

  for (const phase of ["headers", "body"] as const) {
    it(`bounds a health check that stalls reading ${phase}`, async () => {
      const server = Bun.serve({
        port: 0,
        fetch: () => phase === "headers"
          ? new Promise<Response>(() => {})
          : new Response(new ReadableStream({
              start(controller) { controller.enqueue(new TextEncoder().encode('{"healthy":')); },
            }), { headers: { "content-type": "application/json" } }),
      });
      servers.push(server);
      const started = Date.now();
      await expect(waitForOpenCodeServer(server.url.href.replace(/\/$/, ""), 80))
        .rejects.toThrow("failed to start within 80ms");
      expect(Date.now() - started).toBeLessThan(1000);
    });
  }

  it("accepts a healthy server after a temporary failure", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => ++requests === 1
        ? new Response("starting", { status: 503 })
        : Response.json({ healthy: true, version: "test" }),
    });
    servers.push(server);
    await waitForOpenCodeServer(server.url.href.replace(/\/$/, ""), 1000);
    expect(requests).toBe(2);
  });

  it("reports an early process exit without waiting for the deadline", async () => {
    await expect(waitForOpenCodeServer("http://127.0.0.1:1", 30000, { exitCode: 2 }))
      .rejects.toThrow("process died with exit code 2");
  });
});

describe("OpenCode failed-process cleanup", () => {
  let child: Subprocess | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  it("reaps a process that ignores graceful termination", async () => {
    const process = spawn([Bun.which("bun")!, "-e", `
      process.on("SIGTERM", () => {});
      console.log("ready");
      setInterval(() => {}, 1000);
    `], { stdout: "pipe", stderr: "ignore" });
    child = process;
    const reader = process.stdout.getReader();
    await reader.read();
    reader.releaseLock();
    await stopFailedOpenCodeProcess(process, 50);
    expect(process.signalCode).toBe("SIGKILL");
    await process.exited;
  });
});
