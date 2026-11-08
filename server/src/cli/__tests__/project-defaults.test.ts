import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectDefaults } from "../project-defaults";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("init/doctor launch defaults preserve user settings and are idempotent", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coleo defaults "));
  roots.push(workspace);
  const directory = join(workspace, ".coleo");
  await mkdir(directory);
  await writeFile(join(workspace, ".env"), "# application settings\nAPP_PORT=1234\n");
  await writeFile(join(directory, ".env"), "COLEO_API_KEY=keep-secret\n");
  const input = { workspace, directory, connection: "ge", webExecutable: join(directory, "bin/coleo-web") };
  expect((await ensureProjectDefaults(input)).changed).toHaveLength(2);
  expect(await ensureProjectDefaults(input)).toEqual({ changed: [], conflicts: [] });
  const rootEnv = await readFile(join(workspace, ".env"), "utf8");
  expect(rootEnv).toContain("APP_PORT=1234");
  expect(rootEnv).toContain(`COLEO_PROJECT_DIR="${workspace}"`);
  expect(rootEnv).not.toContain("keep-secret");
  expect(await readFile(join(directory, ".env"), "utf8")).toContain("COLEO_API_KEY=keep-secret");
  expect((await stat(join(workspace, ".env"))).mode & 0o777).toBe(0o600);
  const conflict = await ensureProjectDefaults({ ...input, connection: "other" });
  expect(conflict.changed).toEqual([]);
  expect(conflict.conflicts).toHaveLength(2);
  expect(await readFile(join(workspace, ".env"), "utf8")).toBe(rootEnv);
});
