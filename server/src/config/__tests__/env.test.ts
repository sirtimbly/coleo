import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvFileOrigin, loadEnvFile } from "../env";

const environment = { ...process.env };
const roots: string[] = [];
afterEach(async () => {
  process.env = { ...environment };
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("runtime launch defaults retain root env settings and exported overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "coleo-env-"));
  roots.push(root);
  const runtime = join(root, ".coleo");
  await mkdir(runtime);
  await writeFile(join(runtime, ".env"), `COLEO_PROJECT_DIR="${root}"\nCOLEO_API_PORT=8123\n`);
  await writeFile(join(root, ".env"), "COLEO_API_PORT=9999\nCOLEO_ENV_TEST_ROOT=root\nCOLEO_ENV_TEST_EXPORTED=file\n");
  process.env.COLEO_DIR = runtime;
  process.env.COLEO_ENV_TEST_EXPORTED = "exported";
  delete process.env.COLEO_PROJECT_DIR;
  delete process.env.COLEO_API_PORT;
  delete process.env.COLEO_ENV_TEST_ROOT;
  await loadEnvFile();
  expect(String(process.env.COLEO_API_PORT)).toBe("8123");
  expect(String(process.env.COLEO_ENV_TEST_ROOT)).toBe("root");
  expect(getEnvFileOrigin("COLEO_ENV_TEST_ROOT")).toBe(join(root, ".env"));
  expect(process.env.COLEO_ENV_TEST_EXPORTED).toBe("exported");
});
