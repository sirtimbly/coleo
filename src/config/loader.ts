/**
 * Configuration Loader
 * 
 * Loads configuration from:
 * 1. TOML file (~/.octopai/config.toml)
 * 2. Database (config table)
 * 3. Environment variables
 * 
 * Priority: Environment > Database > TOML > Defaults
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "smol-toml";
import type { OctopaiConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";

/**
 * TOML file structure (snake_case for TOML convention)
 */
interface TomlConfig {
  version?: number;
  brain?: {
    poll_interval_ms?: number;
    max_arms?: number;
    arm_grace_period_minutes?: number;
  };
  mail?: {
    from_address?: string;
    digest_schedule?: string;
  };
  gitea?: {
    url?: string;
    token?: string;
    default_org?: string;
    default_repo?: string;
  };
  terminal?: {
    emulator?: string;
  };
  defaults?: {
    harness?: string;
    provider?: string;
    model?: string;
    context_budget?: number;
  };
}

/**
 * Get the default octopai directory
 * Uses .octopai/ in the current working directory (project-local config)
 * Can be overridden with OCTOPAI_DIR environment variable
 */
export function getOctopaiDir(): string {
  return process.env.OCTOPAI_DIR || join(process.cwd(), ".octopai");
}

/**
 * Get the path to the config file
 */
export function getConfigPath(octopaiDir?: string): string {
  return join(octopaiDir || getOctopaiDir(), "config.toml");
}

/**
 * Read and parse the TOML config file
 */
export async function readTomlConfig(octopaiDir?: string): Promise<TomlConfig | null> {
  const configPath = getConfigPath(octopaiDir);
  try {
    const content = await readFile(configPath, "utf-8");
    return parse(content) as TomlConfig;
  } catch {
    return null;
  }
}

/**
 * Write the TOML config file
 */
export async function writeTomlConfig(
  config: TomlConfig,
  octopaiDir?: string
): Promise<void> {
  const configPath = getConfigPath(octopaiDir);
  const header = `# Octopai Configuration
# Updated: ${new Date().toISOString()}

`;
  const content = header + stringify(config);
  await writeFile(configPath, content, "utf-8");
}

/**
 * Convert TOML config (snake_case) to OctopaiConfig (camelCase)
 */
function tomlToConfig(toml: TomlConfig, octopaiDir: string): Partial<OctopaiConfig> {
  const config: Partial<OctopaiConfig> = {
    version: toml.version,
    octopaiDir,
  };

  if (toml.brain) {
    config.brain = {
      pollIntervalMs: toml.brain.poll_interval_ms ?? DEFAULT_CONFIG.brain.pollIntervalMs,
      maxArms: toml.brain.max_arms ?? DEFAULT_CONFIG.brain.maxArms,
      armGracePeriodMinutes: toml.brain.arm_grace_period_minutes ?? DEFAULT_CONFIG.brain.armGracePeriodMinutes,
    };
  }

  if (toml.mail) {
    config.mail = {
      fromAddress: toml.mail.from_address ?? DEFAULT_CONFIG.mail.fromAddress,
      digestSchedule: (toml.mail.digest_schedule as OctopaiConfig["mail"]["digestSchedule"]) ?? DEFAULT_CONFIG.mail.digestSchedule,
    };
  }

  if (toml.gitea) {
    config.gitea = {
      url: toml.gitea.url ?? "",
      token: toml.gitea.token ?? "",
      defaultOrg: toml.gitea.default_org ?? "",
      defaultRepo: toml.gitea.default_repo ?? "",
    };
  }

  if (toml.terminal) {
    config.terminal = {
      emulator: (toml.terminal.emulator as OctopaiConfig["terminal"]["emulator"]) ?? DEFAULT_CONFIG.terminal.emulator,
    };
  }

  if (toml.defaults) {
    config.defaults = {
      harness: toml.defaults.harness ?? DEFAULT_CONFIG.defaults.harness,
      provider: toml.defaults.provider ?? DEFAULT_CONFIG.defaults.provider,
      model: toml.defaults.model ?? DEFAULT_CONFIG.defaults.model,
      contextBudget: toml.defaults.context_budget ?? DEFAULT_CONFIG.defaults.contextBudget,
    };
  }

  return config;
}

/**
 * Convert OctopaiConfig (camelCase) to TOML config (snake_case)
 */
export function configToToml(config: Partial<OctopaiConfig>): TomlConfig {
  const toml: TomlConfig = {
    version: config.version ?? DEFAULT_CONFIG.version,
  };

  if (config.brain) {
    toml.brain = {
      poll_interval_ms: config.brain.pollIntervalMs,
      max_arms: config.brain.maxArms,
    };
  }

  if (config.mail) {
    toml.mail = {
      from_address: config.mail.fromAddress,
      digest_schedule: config.mail.digestSchedule,
    };
  }

  if (config.gitea) {
    toml.gitea = {
      url: config.gitea.url,
      token: config.gitea.token,
      default_org: config.gitea.defaultOrg,
      default_repo: config.gitea.defaultRepo,
    };
  }

  if (config.terminal) {
    toml.terminal = {
      emulator: config.terminal.emulator,
    };
  }

  if (config.defaults) {
    toml.defaults = {
      harness: config.defaults.harness,
      provider: config.defaults.provider,
      model: config.defaults.model,
      context_budget: config.defaults.contextBudget,
    };
  }

  return toml;
}

/**
 * Load full configuration, merging TOML file with defaults
 */
export async function loadConfig(octopaiDir?: string): Promise<OctopaiConfig> {
  const dir = octopaiDir || getOctopaiDir();
  
  // Start with defaults
  const config: OctopaiConfig = { ...DEFAULT_CONFIG, octopaiDir: dir };

  // Load TOML file
  const toml = await readTomlConfig(dir);
  if (toml) {
    const tomlConfig = tomlToConfig(toml, dir);
    
    // Merge TOML into config
    if (tomlConfig.brain) {
      config.brain = { ...config.brain, ...tomlConfig.brain };
    }
    if (tomlConfig.mail) {
      config.mail = { ...config.mail, ...tomlConfig.mail };
    }
    if (tomlConfig.gitea) {
      config.gitea = tomlConfig.gitea;
    }
    if (tomlConfig.terminal) {
      config.terminal = { ...config.terminal, ...tomlConfig.terminal };
    }
    if (tomlConfig.defaults) {
      config.defaults = { ...config.defaults, ...tomlConfig.defaults };
    }
  }

  // Override with environment variables
  if (process.env.OCTOPAI_POLL_INTERVAL_MS) {
    config.brain.pollIntervalMs = parseInt(process.env.OCTOPAI_POLL_INTERVAL_MS, 10);
  }
  if (process.env.OCTOPAI_MAX_ARMS) {
    config.brain.maxArms = parseInt(process.env.OCTOPAI_MAX_ARMS, 10);
  }
  if (process.env.OCTOPAI_ARM_GRACE_PERIOD_MINUTES) {
    config.brain.armGracePeriodMinutes = parseInt(process.env.OCTOPAI_ARM_GRACE_PERIOD_MINUTES, 10);
  }
  if (process.env.OCTOPAI_DEFAULT_HARNESS) {
    config.defaults.harness = process.env.OCTOPAI_DEFAULT_HARNESS;
  }
  if (process.env.OCTOPAI_DEFAULT_PROVIDER) {
    config.defaults.provider = process.env.OCTOPAI_DEFAULT_PROVIDER;
  }
  if (process.env.OCTOPAI_DEFAULT_MODEL) {
    config.defaults.model = process.env.OCTOPAI_DEFAULT_MODEL;
  }

  return config;
}

/**
 * Update configuration in TOML file
 */
export async function updateConfig(
  updates: Partial<OctopaiConfig>,
  octopaiDir?: string
): Promise<OctopaiConfig> {
  const dir = octopaiDir || getOctopaiDir();
  
  // Load current config
  const current = await loadConfig(dir);
  
  // Merge updates
  const updated: OctopaiConfig = {
    ...current,
    ...updates,
    brain: updates.brain ? { ...current.brain, ...updates.brain } : current.brain,
    mail: updates.mail ? { ...current.mail, ...updates.mail } : current.mail,
    terminal: updates.terminal ? { ...current.terminal, ...updates.terminal } : current.terminal,
    defaults: updates.defaults ? { ...current.defaults, ...updates.defaults } : current.defaults,
  };
  
  if (updates.gitea) {
    updated.gitea = { ...current.gitea, ...updates.gitea } as OctopaiConfig["gitea"];
  }
  
  // Write back to TOML
  const toml = configToToml(updated);
  await writeTomlConfig(toml, dir);
  
  return updated;
}
