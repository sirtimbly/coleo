import { mkdir, readFile, realpath, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function findWebCheckout(): Promise<string | undefined> {
  let directory = dirname(await realpath(fileURLToPath(import.meta.url)));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "coleo" && await Bun.file(join(directory, "clients/web/host.ts")).exists()) return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
/** Prepare only the web assets/launcher; never start the API, Brain, or web server. */
export async function prepareCheckoutWeb(runtime: string, build: (root: string) => Promise<void>,
  root?: string): Promise<string | undefined> {
  root ??= await findWebCheckout();
  if (!root) return undefined;
  const host = join(root, "clients/web/dist/host.js");
  const index = join(root, "clients/web/dist/index.html");
  if (!await Bun.file(host).exists() || !await Bun.file(index).exists()) {
    process.stderr.write(`  Building the web client from ${root}…\n`);
    await build(root);
  }
  if (!await Bun.file(host).exists() || !await Bun.file(index).exists()) {
    throw new Error(`Web build did not produce host.js and index.html. Run bun run web:build in ${root}.`);
  }
  const directory = join(runtime, "bin");
  await mkdir(directory, { recursive: true });
  const launcher = join(directory, "coleo-web");
  const content = `#!/bin/sh\n# Coleo linked-checkout web launcher\nexec ${shellQuote(process.execPath)} ${shellQuote(host)} "$@"\n`;
  try { await writeFile(launcher, content, { flag: "wx", mode: 0o755 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(launcher, "utf8") !== content) throw new Error(`A different launcher already exists at ${launcher}; it was preserved.`);
  }
  await chmod(launcher, 0o755);
  process.stderr.write(`  Web host ready: ${launcher}\n`);
  return launcher;
}
