import { describe, expect, it } from "bun:test";
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
});
