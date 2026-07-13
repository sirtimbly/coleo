import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  collectCloudflareAgentInputs,
  computeCloudflareAgentImageTag,
} from "../cloudflare-agent-image-tag";

describe("Cloudflare Arm Host image tag", () => {
  it("tracks the Arm Host bundle without control or web-only sources", async () => {
    const inputs = await collectCloudflareAgentInputs();
    expect(inputs).toContain("src/agent/cloudflare-entry.ts");
    expect(inputs).toContain("src/mcp/server.ts");
    expect(inputs).toContain("docker/cloudflare-agent-entrypoint.sh");
    expect(inputs).not.toContain("src/api/server.ts");
    expect(inputs).not.toContain("src/brain/index.ts");
    expect(inputs).not.toContain("src/cli/index.ts");
    expect(inputs.some((path) => path.startsWith("src/web/"))).toBe(false);
    expect(inputs.some((path) => path.startsWith("src/docs/"))).toBe(false);
  });

  it("produces a stable content-addressed tag", async () => {
    const first = await computeCloudflareAgentImageTag();
    const second = await computeCloudflareAgentImageTag();
    expect(first).toMatch(/^runtime-[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("requires an explicitly pinned OpenCode version", async () => {
    const dockerfile = await readFile(
      resolve(import.meta.dir, "../../../Dockerfile.cloudflare-agent"),
      "utf8",
    );
    expect(dockerfile).toMatch(/bun install --global "opencode-ai@\d+\.\d+\.\d+"/);
    expect(dockerfile).not.toContain("opencode-ai@latest");
    expect(dockerfile).not.toContain("OPENCODE_VERSION");
  });
});
