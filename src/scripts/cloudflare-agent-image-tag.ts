import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const ENTRYPOINT = "src/agent/cloudflare-entry.ts";
const IMAGE_INPUTS = [
  "Dockerfile.cloudflare-agent",
  "docker/cloudflare-agent-entrypoint.sh",
  "node_modules/bun-pty/package.json",
  "node_modules/bun-pty/src/index.ts",
  "node_modules/bun-pty/src/interfaces.ts",
  "node_modules/bun-pty/src/terminal.ts",
  "node_modules/bun-pty/rust-pty/target/release/librust_pty.so",
] as const;

let collectedInputs: Promise<string[]> | undefined;

export async function collectCloudflareAgentInputs(): Promise<string[]> {
  collectedInputs ??= collectInputs();
  return collectedInputs;
}

async function collectInputs(): Promise<string[]> {
  const outdir = await mkdtemp(join(tmpdir(), "coleo-agent-tag-"));
  try {
    const result = await Bun.build({
      entrypoints: [resolve(REPOSITORY_ROOT, ENTRYPOINT)],
      outdir,
      target: "bun",
      metafile: true,
    });
    if (!result.success) {
      throw new Error(result.logs.map((log) => log.message).join("\n"));
    }
    if (!result.metafile) throw new Error("Arm Host bundle did not produce dependency metadata");
    const bundledInputs = Object.keys(result.metafile.inputs).map((path) => {
      const absolute = resolve(REPOSITORY_ROOT, path);
      return relative(REPOSITORY_ROOT, absolute).replaceAll("\\", "/");
    });
    return [...new Set([...bundledInputs, ...IMAGE_INPUTS])].sort();
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
}

export async function computeCloudflareAgentImageTag(): Promise<string> {
  const hash = createHash("sha256");
  for (const path of await collectCloudflareAgentInputs()) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(REPOSITORY_ROOT, path)));
    hash.update("\0");
  }
  return `runtime-${hash.digest("hex")}`;
}

if (import.meta.main) {
  console.log(await computeCloudflareAgentImageTag());
}
