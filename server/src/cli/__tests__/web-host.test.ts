import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("bundled web host runs from its artifact, independently of cwd, with selected API credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "coleo-web-artifact-"));
  const dist = join(root, "web");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<title>Installed client</title>");
  const artifact = join(dist, "host.js");
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../clients/web/host.ts")],
    target: "bun", outdir: dist, naming: "host.js" });
  expect(build.success).toBe(true);
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    return new Response(req.headers.get("authorization") === "Bearer artifact-secret" ? "authenticated" : "denied");
  } });
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(); } });
  const port = probe.port!;
  probe.stop(true);
  const process = Bun.spawn([Bun.which("bun")!, artifact, "--port", String(port)], {
    cwd: root, env: { ...Bun.env, COLEO_API_URL: api.url.toString(), COLEO_API_KEY: "artifact-secret" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = process.stdout.getReader();
    const startup = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(startup.value)).toContain("Coleo web client:");
    const url = `http://127.0.0.1:${port}`;
    expect(await (await fetch(url)).text()).toBe("<title>Installed client</title>");
    expect(await (await fetch(`${url}/api/status`)).text()).toBe("authenticated");
    process.kill("SIGINT");
    expect(await process.exited).toBe(130);
    expect(await new Response(process.stderr).text()).not.toContain("artifact-secret");
    for (const option of ["--help", "--version"]) {
      const command = Bun.spawn([Bun.which("bun")!, artifact, option], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(await command.exited).toBe(0);
      expect((await new Response(command.stdout).text()).trim().length).toBeGreaterThan(0);
    }
  } finally {
    process.kill();
    await process.exited;
    api.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
