import { describe, expect, it } from "bun:test";

import {
  createColeoMiseEnvironment,
  generateApiKey,
  readColeoMiseEnvironment,
  updateMiseToml,
} from "../init-environment";

describe("init environment", () => {
  it("generates a secure API key", () => {
    expect(generateApiKey()).toMatch(/^co_[a-f0-9]{64}$/);
  });

  it("generates distinct project ports and preserves existing values", async () => {
    const checked: number[] = [];
    const environment = await createColeoMiseEnvironment(
      "/workspace/project",
      { COLEO_NATS_PORT: "24422", COLEO_API_KEY: "co_existing" },
      async (port) => {
        checked.push(port);
        return true;
      },
    );

    expect(environment.COLEO_API_PORT).not.toBe(environment.COLEO_NATS_PORT);
    expect(environment.COLEO_NATS_PORT).toBe("24422");
    expect(environment.COLEO_NATS_HTTP_PORT).not.toBe(environment.COLEO_NATS_PORT);
    expect(environment.COLEO_API_KEY).toBe("co_existing");
    expect(new Set(checked).size).toBe(2);
  });

  it("adds Coleo values without replacing unrelated mise configuration", () => {
    const original = `[tools]\nbun = "latest"\n\n[env]\nEXISTING = "value"\n\n[tasks.dev]\nrun = "bun run dev"\n`;
    const updated = updateMiseToml(original, {
      COLEO_PROJECT_DIR: "/workspace/project",
      COLEO_API_HOST: "127.0.0.1",
      COLEO_API_PORT: "18080",
      COLEO_NATS_HOST: "127.0.0.1",
      COLEO_NATS_PORT: "14222",
      COLEO_NATS_HTTP_PORT: "18222",
      COLEO_API_KEY: "co_secret",
    });

    expect(updated).toContain('EXISTING = "value"');
    expect(updated).toContain('[tasks.dev]\nrun = "bun run dev"');
    expect(readColeoMiseEnvironment(updated)).toEqual({
      COLEO_PROJECT_DIR: "/workspace/project",
      COLEO_API_HOST: "127.0.0.1",
      COLEO_API_PORT: "18080",
      COLEO_NATS_HOST: "127.0.0.1",
      COLEO_NATS_PORT: "14222",
      COLEO_NATS_HTTP_PORT: "18222",
      COLEO_API_KEY: "co_secret",
    });
  });

  it("updates existing Coleo values without duplicating them", () => {
    const original = `[env]\nCOLEO_API_PORT = "18080"\n`;
    const updated = updateMiseToml(original, {
      COLEO_PROJECT_DIR: "/workspace/project",
      COLEO_API_HOST: "127.0.0.1",
      COLEO_API_PORT: "18081",
      COLEO_NATS_HOST: "127.0.0.1",
      COLEO_NATS_PORT: "14222",
      COLEO_NATS_HTTP_PORT: "18222",
      COLEO_API_KEY: "co_secret",
    });

    expect(updated.match(/COLEO_API_PORT/g)).toHaveLength(1);
    expect(readColeoMiseEnvironment(updated).COLEO_API_PORT).toBe("18081");
  });

  it("creates an env section in a new mise file", () => {
    const updated = updateMiseToml("", {
      COLEO_PROJECT_DIR: "/workspace/project",
      COLEO_API_HOST: "127.0.0.1",
      COLEO_API_PORT: "18080",
      COLEO_NATS_HOST: "127.0.0.1",
      COLEO_NATS_PORT: "14222",
      COLEO_NATS_HTTP_PORT: "18222",
      COLEO_API_KEY: "co_secret",
    });

    expect(updated.startsWith("[env]\n")).toBe(true);
    expect(readColeoMiseEnvironment(updated).COLEO_API_KEY).toBe("co_secret");
  });
});
