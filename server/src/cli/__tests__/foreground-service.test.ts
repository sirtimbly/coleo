import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getLogFilePath, getServiceStatus, registerServiceProcess, startService } from "../../daemon";

let directory: string;
const originalColeoDir = process.env.COLEO_DIR;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coleo-foreground-service-"));
  process.env.COLEO_DIR = directory;
});
afterEach(async () => {
  if (originalColeoDir === undefined) delete process.env.COLEO_DIR;
  else process.env.COLEO_DIR = originalColeoDir;
  await rm(directory, { recursive: true, force: true });
});

it("reuses a registered foreground server without launching a duplicate or truncating its log", async () => {
  await registerServiceProcess("server");
  await writeFile(getLogFilePath("server"), "existing server log\n");
  const before = await getServiceStatus("server");
  const started = await startService("server");
  expect(started.running).toBe(true);
  expect(started.pid).toBe(process.pid);
  expect(started.startedAt).toBe(before.startedAt);
  expect(await readFile(getLogFilePath("server"), "utf8")).toBe("existing server log\n");
});
