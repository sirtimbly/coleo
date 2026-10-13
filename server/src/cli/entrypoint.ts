import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getCliEntrypoint(): string {
  const envEntrypoint = process.env.COLEO_CLI_ENTRYPOINT;
  if (envEntrypoint) {
    return resolve(envEntrypoint);
  }

  const argvEntrypoint = process.argv[1];
  if (argvEntrypoint) {
    return resolve(argvEntrypoint);
  }

  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = dirname(modulePath);
  const tsEntrypoint = resolve(moduleDir, "index.ts");
  if (existsSync(tsEntrypoint)) {
    return tsEntrypoint;
  }

  const jsEntrypoint = resolve(moduleDir, "index.js");
  if (existsSync(jsEntrypoint)) {
    return jsEntrypoint;
  }

  return tsEntrypoint;
}
