import { afterEach, describe, expect, it } from "bun:test";
import { parseCloudflareAgentOptions } from "../cloudflare-entry";

const originalAgentId = process.env.COLEO_AGENT_ID;
const originalNatsUrl = process.env.COLEO_NATS_URL;

afterEach(() => {
  if (originalAgentId === undefined) delete process.env.COLEO_AGENT_ID;
  else process.env.COLEO_AGENT_ID = originalAgentId;
  if (originalNatsUrl === undefined) delete process.env.COLEO_NATS_URL;
  else process.env.COLEO_NATS_URL = originalNatsUrl;
});

describe("Cloudflare Arm Host entrypoint", () => {
  it("parses the dedicated Arm Host runtime flags", () => {
    expect(parseCloudflareAgentOptions([
      "--id", "reef-project",
      "--nats-url", "nats://nats:4222",
      "--max-arms", "7",
      "--heartbeat-interval", "15000",
      "--verbose",
    ])).toEqual({
      agentId: "reef-project",
      natsUrl: "nats://nats:4222",
      maxArms: 7,
      heartbeatIntervalMs: 15_000,
      verbose: true,
    });
  });

  it("uses hosted environment defaults", () => {
    process.env.COLEO_AGENT_ID = "reef-env";
    process.env.COLEO_NATS_URL = "nats://env:4222";
    expect(parseCloudflareAgentOptions([])).toMatchObject({
      agentId: "reef-env",
      natsUrl: "nats://env:4222",
      maxArms: 10,
    });
  });

  it("rejects invalid numeric options", () => {
    expect(() => parseCloudflareAgentOptions(["--max-arms", "0"]))
      .toThrow("--max-arms must be a positive integer");
    expect(() => parseCloudflareAgentOptions(["--max-arms", "7arms"]))
      .toThrow("--max-arms must be a positive integer");
  });
});
