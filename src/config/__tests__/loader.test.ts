import { describe, it, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getColeoDir,
  getConfigPath,
  readTomlConfig,
  writeTomlConfig,
  configToToml,
  loadConfig,
  updateConfig,
} from "../loader";

const createTempDir = async () => {
  const dir = join(tmpdir(), `coleo-config-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
};

describe("config loader", () => {
  it("getColeoDir respects COLEO_DIR env", () => {
    const original = process.env.COLEO_DIR;
    process.env.COLEO_DIR = "/tmp/custom-coleo";
    try {
      expect(getColeoDir()).toBe("/tmp/custom-coleo");
    } finally {
      if (original === undefined) {
        delete process.env.COLEO_DIR;
      } else {
        process.env.COLEO_DIR = original;
      }
    }
  });

  it("readTomlConfig returns null when file missing", async () => {
    const dir = await createTempDir();
    try {
      const result = await readTomlConfig(dir);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writeTomlConfig writes readable TOML", async () => {
    const dir = await createTempDir();
    try {
      await writeTomlConfig(
        {
          version: 1,
          brain: { poll_interval_ms: 1234 },
          mail: { from_address: "ops@example.test", digest_schedule: "daily" },
          defaults: { harness: "opencode", provider: "openai", model: "gpt-4o" },
        },
        dir
      );

      const parsed = await readTomlConfig(dir);
      expect(parsed?.version).toBe(1);
      expect(parsed?.brain?.poll_interval_ms).toBe(1234);
      expect(parsed?.mail?.from_address).toBe("ops@example.test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("configToToml maps camelCase to snake_case", () => {
    const toml = configToToml({
      version: 2,
      brain: { pollIntervalMs: 5000, maxArms: 3, armGracePeriodMinutes: 10 },
      mail: { fromAddress: "bot@example.test", digestSchedule: "weekly" },
      gitea: { url: "https://gitea.test", token: "tok", defaultOrg: "org", defaultRepo: "repo" },
      terminal: { emulator: "tmux" },
      defaults: { harness: "opencode", provider: "openai", model: "gpt-4o", contextBudget: 8000 },
    });

    expect(toml.version).toBe(2);
    expect(toml.brain?.poll_interval_ms).toBe(5000);
    expect(toml.mail?.from_address).toBe("bot@example.test");
    expect(toml.gitea?.default_org).toBe("org");
    expect(toml.terminal?.emulator).toBe("tmux");
    expect(toml.defaults?.context_budget).toBe(8000);
  });

  it("loadConfig merges TOML and env overrides", async () => {
    const dir = await createTempDir();
    const envSnapshot = {
      COLEO_POLL_INTERVAL_MS: process.env.COLEO_POLL_INTERVAL_MS,
      COLEO_MAX_ARMS: process.env.COLEO_MAX_ARMS,
      COLEO_ARM_GRACE_PERIOD_MINUTES: process.env.COLEO_ARM_GRACE_PERIOD_MINUTES,
      COLEO_DEFAULT_HARNESS: process.env.COLEO_DEFAULT_HARNESS,
      COLEO_DEFAULT_PROVIDER: process.env.COLEO_DEFAULT_PROVIDER,
      COLEO_DEFAULT_MODEL: process.env.COLEO_DEFAULT_MODEL,
    };

    try {
      await writeTomlConfig(
        {
          version: 1,
          brain: { poll_interval_ms: 1000, max_arms: 2, arm_grace_period_minutes: 5 },
          defaults: { harness: "opencode", provider: "openai", model: "gpt-4o" },
        },
        dir
      );

      process.env.COLEO_POLL_INTERVAL_MS = "2000";
      process.env.COLEO_MAX_ARMS = "4";
      process.env.COLEO_ARM_GRACE_PERIOD_MINUTES = "8";
      process.env.COLEO_DEFAULT_MODEL = "gpt-4o-mini";

      const loaded = await loadConfig(dir);
      expect(loaded.brain.pollIntervalMs).toBe(2000);
      expect(loaded.brain.maxArms).toBe(4);
      expect(loaded.brain.armGracePeriodMinutes).toBe(8);
      expect(loaded.defaults.model).toBe("gpt-4o-mini");
    } finally {
      for (const [key, value] of Object.entries(envSnapshot)) {
        if (value === undefined) {
          delete process.env[key as keyof typeof envSnapshot];
        } else {
          process.env[key as keyof typeof envSnapshot] = value;
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("updateConfig merges updates and writes TOML", async () => {
    const dir = await createTempDir();
    try {
      await writeTomlConfig(
        {
          version: 1,
          brain: { poll_interval_ms: 1000, max_arms: 2 },
          defaults: { harness: "opencode", provider: "openai", model: "gpt-4o" },
        },
        dir
      );

      const updated = await updateConfig(
        {
          brain: { maxArms: 5 },
          gitea: { url: "https://gitea.test", token: "tok", defaultOrg: "org", defaultRepo: "repo" },
        },
        dir
      );

      expect(updated.brain.maxArms).toBe(5);
      expect(updated.gitea.url).toBe("https://gitea.test");

      const reloaded = await readTomlConfig(dir);
      expect(reloaded?.brain?.max_arms).toBe(5);
      expect(reloaded?.gitea?.url).toBe("https://gitea.test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("getConfigPath resolves under coleo dir", async () => {
    const dir = await createTempDir();
    try {
      const path = getConfigPath(dir);
      expect(path).toBe(join(dir, "config.toml"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
