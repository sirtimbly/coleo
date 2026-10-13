import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  parseCloudflareAgentOptions,
  type CloudflareRuntimeHandlers,
} from "../cloudflare-entry";

const trackedEnv = [
  "COLEO_AGENT_ID",
  "COLEO_NATS_HOST",
  "COLEO_NATS_PORT",
  "COLEO_NATS_URL",
  "COLEO_DIR",
  "COLEO_TEST_FILE_SECRET",
  "COLEO_TEST_CONTAINER_SECRET",
] as const;
const originalEnv = Object.fromEntries(
  trackedEnv.map((key) => [key, process.env[key]]),
) as Record<(typeof trackedEnv)[number], string | undefined>;

afterEach(() => {
  for (const key of trackedEnv) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

  it("uses the shared NATS host and port when no URL is configured", () => {
    delete process.env.COLEO_NATS_URL;
    process.env.COLEO_NATS_HOST = "127.0.0.4";
    process.env.COLEO_NATS_PORT = "14422";

    expect(parseCloudflareAgentOptions([]).natsUrl).toBe("nats://127.0.0.4:14422");
  });

  it("rejects invalid numeric options", () => {
    expect(() => parseCloudflareAgentOptions(["--max-arms", "0"]))
      .toThrow("--max-arms must be a positive integer");
    expect(() => parseCloudflareAgentOptions(["--max-arms", "7arms"]))
      .toThrow("--max-arms must be a positive integer");
  });

  it("loads restored Coleo env before runtime dispatch without overriding container values", async () => {
    const coleoDir = await mkdtemp(join(tmpdir(), "coleo-cloudflare-env-"));
    try {
      await writeFile(join(coleoDir, ".env"), [
        "COLEO_TEST_FILE_SECRET=from-restored-env",
        "COLEO_TEST_CONTAINER_SECRET=from-restored-env",
      ].join("\n"));
      process.env.COLEO_DIR = coleoDir;
      delete process.env.COLEO_TEST_FILE_SECRET;
      process.env.COLEO_TEST_CONTAINER_SECRET = "from-container";

      let observed: Record<string, string | undefined> = {};
      const handlers: CloudflareRuntimeHandlers = {
        startAgent: async () => {
          throw new Error("agent mode should not run");
        },
        serveMcp: async () => {
          observed = {
            fileSecret: process.env.COLEO_TEST_FILE_SECRET,
            containerSecret: process.env.COLEO_TEST_CONTAINER_SECRET,
          };
        },
      };

      await main(["mcp", "serve"], handlers);

      expect(observed).toEqual({
        fileSecret: "from-restored-env",
        containerSecret: "from-container",
      });
    } finally {
      await rm(coleoDir, { recursive: true, force: true });
    }
  });
});
