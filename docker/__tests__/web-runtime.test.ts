import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url);

test.each(["cloudflare-entrypoint.sh", "cloudflare-control-entrypoint.sh"])(
"%s separates web/API ports and stops the API when the web host exits", async runtime => {
  const dir = await mkdtemp(join(tmpdir(), "coleo-container-test-"));
  const log = join(dir, "calls.jsonl");
  const mock = `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const name = process.argv[1].split("/").at(-1);
const record = (event) => appendFileSync(process.env.TEST_LOG, JSON.stringify({
  name, event, args: process.argv.slice(2), api: process.env.COLEO_API_URL
}) + "\\n");
record("start");
if (name === "curl") process.exit(0);
if (name === "bun" && process.argv[2] === "-e") process.exit(0);
if (name === "sleep") { setTimeout(() => process.exit(0), 20); }
else if (name === "coleo-web") {
  const timer = setInterval(() => {
    if (readFileSync(process.env.TEST_LOG, "utf8").includes('"args":["brain","run"]')) {
      clearInterval(timer);
      setTimeout(() => process.exit(23), 100);
    }
  }, 20);
}
else {
  process.on("SIGTERM", () => { record("stop"); process.exit(0); });
  setInterval(() => {}, 1000);
}
`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    for (const name of ["coleo", "coleo-web", "curl", "sleep", "bun", "qdrant"]) {
      const path = join(dir, name);
      await Bun.write(path, mock);
      await chmod(path, 0o755);
    }
    child = Bun.spawn(["bash", new URL(`docker/${runtime}`, root).pathname], {
      env: {
        PATH: `${dir}:${process.env.PATH}`, HOME: dir, TEST_LOG: log,
        COLEO_DIR: join(dir, "state"), PORT: "3456", COLEO_API_INTERNAL_PORT: "3457",
        COLEO_QDRANT_SNAPSHOT_DIR: join(dir, "snapshots"), COLEO_QDRANT_CONFIG: join(dir, "qdrant.yaml"),
      },
      stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    const calls = (await Bun.file(log).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(calls).toContainEqual({ name: "coleo", event: "start", args: ["serve", "--host", "127.0.0.1", "--port", "3457"] });
    expect(calls).toContainEqual({ name: "coleo-web", event: "start", args: ["--host", "0.0.0.0", "--port", "3456"], api: "http://127.0.0.1:3457" });
    expect(calls.some(call => call.name === "curl" && call.args.includes("http://127.0.0.1:3457/api/health"))).toBe(true);
    expect(calls.filter(call => call.name === "coleo" && call.event === "stop")).toHaveLength(2);
  } finally {
    child?.kill();
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
