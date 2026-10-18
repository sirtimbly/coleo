import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getCliEntrypoint(role: "server" | "agent" | "legacy" = "legacy"): string {
  const envEntrypoint = process.env[role === "legacy" ? "COLEO_CLI_ENTRYPOINT" : `COLEO_${role.toUpperCase()}_ENTRYPOINT`];
  if (envEntrypoint) {
    return resolve(envEntrypoint);
  }

  const argvEntrypoint = process.argv[1];
  if (role === "legacy" && argvEntrypoint && ["index.ts", "index.js", "coleo"].includes(basename(argvEntrypoint))) {
    return resolve(argvEntrypoint);
  }

  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = dirname(modulePath);
  const name = role === "legacy" ? "index" : role;
  const tsEntrypoint = resolve(moduleDir, `${name}.ts`);
  if (existsSync(tsEntrypoint)) {
    return tsEntrypoint;
  }

  const jsEntrypoint = resolve(moduleDir, `${name}.js`);
  if (existsSync(jsEntrypoint)) {
    return jsEntrypoint;
  }

  return tsEntrypoint;
}
