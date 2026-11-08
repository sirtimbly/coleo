import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findWebCheckout, prepareCheckoutWeb } from "../ops-web";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "coleo-web-setup-")); temporary.push(parent);
  const root = join(parent, "checkout with 'quotes'");
  const runtime = join(parent, "project runtime");
  return { root, runtime, dist: join(root, "clients/web/dist") };
}
test("finds the linked tool's checkout rather than the user's working directory", async () => {
  expect(await findWebCheckout()).toBe(resolve(import.meta.dir, "../../../.."));
});
test("builds missing web assets once and creates an executable launcher with safely quoted paths", async () => {
  const { root, runtime, dist } = await fixture();
  let builds = 0;
  const build = async (directory: string) => {
    expect(directory).toBe(root); builds++;
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "index.html"), "<html>web</html>");
    await writeFile(join(dist, "host.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
  };
  const launcher = await prepareCheckoutWeb(runtime, build, root);
  expect(launcher).toBe(join(runtime, "bin/coleo-web"));
  const child = Bun.spawn([launcher!, "--host", "127.0.0.1", "--port", "3000"], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual(["--host", "127.0.0.1", "--port", "3000"]);
  expect((await stat(launcher!)).mode & 0o777).toBe(0o755);
  expect(await prepareCheckoutWeb(runtime, build, root)).toBe(launcher);
  expect(builds).toBe(1);
});
test("preserves a conflicting user-authored launcher", async () => {
  const { root, runtime, dist } = await fixture();
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), "web");
  await writeFile(join(dist, "host.js"), "host");
  await mkdir(join(runtime, "bin"), { recursive: true });
  const launcher = join(runtime, "bin/coleo-web");
  await writeFile(launcher, "user-owned launcher");
  await expect(prepareCheckoutWeb(runtime, async () => {}, root)).rejects.toThrow("preserved");
  expect(await readFile(launcher, "utf8")).toBe("user-owned launcher");
});
test("does not report readiness when a build omits its artifacts", async () => {
  const { root, runtime } = await fixture();
  await expect(prepareCheckoutWeb(runtime, async () => {}, root)).rejects.toThrow("did not produce");
  expect(await Bun.file(join(runtime, "bin/coleo-web")).exists()).toBe(false);
});
