/**
 * Configuration Loader
 * 
 * Loads configuration from:
 * 1. TOML file (~/.coleo/config.toml)
 * 2. Database (config table)
 * 3. Environment variables
 * 
 * Priority: Environment > Database > TOML > Defaults
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "smol-toml";
import type { ColeoConfig } from "../types";
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
		refactor_file_threshold_lines?: number;
	};
  mail?: {
    from_address?: string;
    to_address?: string;
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
  docs?: {
    update_file_threshold?: number;
    update_poll_interval?: number;
    update_enabled?: boolean;
  };
  refactoring?: {
    file_size_threshold?: number;
    enabled?: boolean;
  };
  automations?: {
    enabled?: boolean;
    refactor_large_files?: {
      enabled?: boolean;
      min_interval_hours?: number;
      last_run_at?: string | null;
      require_empty_queue?: boolean;
    };
  };
  defaults?: {
    harness?: string;
    provider?: string;
    model?: string;
    context_budget?: number;
  };
  compression?: {
    warning_threshold?: number;
    critical_threshold?: number;
    max_threshold?: number;
    enabled?: boolean;
  };
}

/**
 * Get the default Coleo directory
 * Uses .coleo/ in the current working directory (project-local config)
 * Can be overridden with COLEO_DIR environment variable
 */
export function getColeoDir(): string {
  return process.env.COLEO_DIR || join(process.cwd(), ".coleo");
}

/**
 * Get the path to the config file
 */
export function getConfigPath(coleoDir?: string): string {
  return join(coleoDir || getColeoDir(), "config.toml");
}

/**
 * Read and parse the TOML config file
 */
export async function readTomlConfig(coleoDir?: string): Promise<TomlConfig | null> {
  const configPath = getConfigPath(coleoDir);
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
  coleoDir?: string
): Promise<void> {
  const configPath = getConfigPath(coleoDir);
  const header = `# Coleo Configuration
# Updated: ${new Date().toISOString()}

`;
  const content = header + stringify(config);
  await writeFile(configPath, content, "utf-8");
}

/**
 * Convert TOML config (snake_case) to ColeoConfig (camelCase)
 */
function tomlToConfig(toml: TomlConfig, coleoDir: string): Partial<ColeoConfig> {
  const config: Partial<ColeoConfig> = {
    version: toml.version,
    coleoDir,
  };

	if (toml.brain) {
		config.brain = {
			pollIntervalMs: toml.brain.poll_interval_ms ?? DEFAULT_CONFIG.brain.pollIntervalMs,
			maxArms: toml.brain.max_arms ?? DEFAULT_CONFIG.brain.maxArms,
			armGracePeriodMinutes: toml.brain.arm_grace_period_minutes ?? DEFAULT_CONFIG.brain.armGracePeriodMinutes,
		};
		if (toml.brain.refactor_file_threshold_lines !== undefined) {
			config.refactoring = {
				fileSizeThreshold: toml.brain.refactor_file_threshold_lines,
				enabled: DEFAULT_CONFIG.refactoring.enabled,
			};
		}
	}

  if (toml.mail) {
    config.mail = {
      fromAddress: toml.mail.from_address ?? DEFAULT_CONFIG.mail.fromAddress,
      toAddress: toml.mail.to_address ?? DEFAULT_CONFIG.mail.toAddress,
      digestSchedule: (toml.mail.digest_schedule as ColeoConfig["mail"]["digestSchedule"]) ?? DEFAULT_CONFIG.mail.digestSchedule,
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
      emulator: (toml.terminal.emulator as ColeoConfig["terminal"]["emulator"]) ?? DEFAULT_CONFIG.terminal.emulator,
    };
  }

  if (toml.docs) {
    config.docs = {
      updateFileThreshold:
        toml.docs.update_file_threshold ?? DEFAULT_CONFIG.docs.updateFileThreshold,
      updatePollInterval:
        toml.docs.update_poll_interval ?? DEFAULT_CONFIG.docs.updatePollInterval,
      updateEnabled: toml.docs.update_enabled ?? DEFAULT_CONFIG.docs.updateEnabled,
    };
  }

  if (toml.refactoring) {
    config.refactoring = {
      fileSizeThreshold:
        toml.refactoring.file_size_threshold ?? DEFAULT_CONFIG.refactoring.fileSizeThreshold,
      enabled: toml.refactoring.enabled ?? DEFAULT_CONFIG.refactoring.enabled,
    };
  }

  if (toml.automations) {
    config.automations = {
      enabled: toml.automations.enabled ?? DEFAULT_CONFIG.automations.enabled,
      refactorLargeFiles: {
        enabled: toml.automations.refactor_large_files?.enabled ?? DEFAULT_CONFIG.automations.refactorLargeFiles.enabled,
        minIntervalHours: toml.automations.refactor_large_files?.min_interval_hours ?? DEFAULT_CONFIG.automations.refactorLargeFiles.minIntervalHours,
        lastRunAt: toml.automations.refactor_large_files?.last_run_at ?? DEFAULT_CONFIG.automations.refactorLargeFiles.lastRunAt,
        requireEmptyQueue: toml.automations.refactor_large_files?.require_empty_queue ?? DEFAULT_CONFIG.automations.refactorLargeFiles.requireEmptyQueue,
      },
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

  if (toml.compression) {
    config.compression = {
      warningThreshold: toml.compression.warning_threshold ?? DEFAULT_CONFIG.compression.warningThreshold,
      criticalThreshold: toml.compression.critical_threshold ?? DEFAULT_CONFIG.compression.criticalThreshold,
      maxThreshold: toml.compression.max_threshold ?? DEFAULT_CONFIG.compression.maxThreshold,
      enabled: toml.compression.enabled ?? DEFAULT_CONFIG.compression.enabled,
    };
  }

  return config;
}

/**
 * Convert ColeoConfig (camelCase) to TOML config (snake_case)
 */
export function configToToml(config: Partial<ColeoConfig>): TomlConfig {
  const toml: TomlConfig = {
    version: config.version ?? DEFAULT_CONFIG.version,
  };

	if (config.brain) {
		toml.brain = {
			poll_interval_ms: config.brain.pollIntervalMs,
			max_arms: config.brain.maxArms,
			arm_grace_period_minutes: config.brain.armGracePeriodMinutes,
		};
	}

	if (config.refactoring) {
		toml.refactoring = {
			file_size_threshold: config.refactoring.fileSizeThreshold,
			enabled: config.refactoring.enabled,
		};
	}

	if (config.automations) {
		toml.automations = {
			enabled: config.automations.enabled,
			refactor_large_files: {
				enabled: config.automations.refactorLargeFiles.enabled,
				min_interval_hours: config.automations.refactorLargeFiles.minIntervalHours,
				last_run_at: config.automations.refactorLargeFiles.lastRunAt,
				require_empty_queue: config.automations.refactorLargeFiles.requireEmptyQueue,
			},
		};
	}

  if (config.mail) {
    toml.mail = {
      from_address: config.mail.fromAddress,
      to_address: config.mail.toAddress,
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

  if (config.docs) {
    toml.docs = {
      update_file_threshold: config.docs.updateFileThreshold,
      update_poll_interval: config.docs.updatePollInterval,
      update_enabled: config.docs.updateEnabled,
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

  if (config.compression) {
    toml.compression = {
      warning_threshold: config.compression.warningThreshold,
      critical_threshold: config.compression.criticalThreshold,
      max_threshold: config.compression.maxThreshold,
      enabled: config.compression.enabled,
    };
  }

  return toml;
}

/**
 * Load full configuration, merging TOML file with defaults
 */
export async function loadConfig(coleoDir?: string): Promise<ColeoConfig> {
  const dir = coleoDir || getColeoDir();
  
  // Start with defaults
  const config: ColeoConfig = { ...DEFAULT_CONFIG, coleoDir: dir };

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
    if (tomlConfig.docs) {
      config.docs = { ...config.docs, ...tomlConfig.docs };
    }
    if (tomlConfig.refactoring) {
      config.refactoring = { ...config.refactoring, ...tomlConfig.refactoring };
    }
    if (tomlConfig.defaults) {
      config.defaults = { ...config.defaults, ...tomlConfig.defaults };
    }
    if (tomlConfig.automations) {
      config.automations = {
        ...config.automations,
        ...tomlConfig.automations,
        refactorLargeFiles: {
          ...config.automations.refactorLargeFiles,
          ...tomlConfig.automations.refactorLargeFiles,
        },
      };
    }
    if (tomlConfig.compression) {
      config.compression = { ...config.compression, ...tomlConfig.compression };
    }
  }

  // Override with environment variables
  if (process.env.COLEO_POLL_INTERVAL_MS) {
    config.brain.pollIntervalMs = parseInt(process.env.COLEO_POLL_INTERVAL_MS, 10);
  }
  if (process.env.COLEO_MAX_ARMS) {
    config.brain.maxArms = parseInt(process.env.COLEO_MAX_ARMS, 10);
  }
	if (process.env.COLEO_ARM_GRACE_PERIOD_MINUTES) {
		config.brain.armGracePeriodMinutes = parseInt(process.env.COLEO_ARM_GRACE_PERIOD_MINUTES, 10);
	}
	if (process.env.COLEO_FILE_SIZE_THRESHOLD) {
		config.refactoring.fileSizeThreshold = parseInt(process.env.COLEO_FILE_SIZE_THRESHOLD, 10);
	}
  if (process.env.COLEO_DEFAULT_HARNESS) {
    config.defaults.harness = process.env.COLEO_DEFAULT_HARNESS;
  }
  if (process.env.COLEO_DEFAULT_PROVIDER) {
    config.defaults.provider = process.env.COLEO_DEFAULT_PROVIDER;
  }
  if (process.env.COLEO_DEFAULT_MODEL) {
    config.defaults.model = process.env.COLEO_DEFAULT_MODEL;
  }
  if (process.env.COLEO_COMPRESSION_WARNING_THRESHOLD) {
    config.compression.warningThreshold = parseInt(process.env.COLEO_COMPRESSION_WARNING_THRESHOLD, 10);
  }
  if (process.env.COLEO_COMPRESSION_CRITICAL_THRESHOLD) {
    config.compression.criticalThreshold = parseInt(process.env.COLEO_COMPRESSION_CRITICAL_THRESHOLD, 10);
  }
  if (process.env.COLEO_COMPRESSION_MAX_THRESHOLD) {
    config.compression.maxThreshold = parseInt(process.env.COLEO_COMPRESSION_MAX_THRESHOLD, 10);
  }
  if (process.env.COLEO_COMPRESSION_ENABLED) {
    config.compression.enabled = process.env.COLEO_COMPRESSION_ENABLED === "true";
  }

  return config;
}

/**
 * Update configuration in TOML file
 */
type ColeoConfigUpdates = Omit<Partial<ColeoConfig>, "brain" | "mail" | "terminal" | "defaults" | "gitea" | "automations" | "compression"> & {
  brain?: Partial<ColeoConfig["brain"]>;
  mail?: Partial<ColeoConfig["mail"]>;
  terminal?: Partial<ColeoConfig["terminal"]>;
  docs?: Partial<ColeoConfig["docs"]>;
  defaults?: Partial<ColeoConfig["defaults"]>;
  gitea?: Partial<NonNullable<ColeoConfig["gitea"]>>;
  automations?: {
    enabled?: boolean;
    refactorLargeFiles?: Partial<ColeoConfig["automations"]["refactorLargeFiles"]>;
  };
  compression?: Partial<ColeoConfig["compression"]>;
};

export async function updateConfig(
  updates: ColeoConfigUpdates,
  coleoDir?: string
): Promise<ColeoConfig> {
  const dir = coleoDir || getColeoDir();
  
  // Load current config
  const current = await loadConfig(dir);

  const { gitea, automations, compression, ...rest } = updates;
  
  // Merge updates
  const updated: ColeoConfig = {
    ...current,
    ...rest,
    brain: updates.brain ? { ...current.brain, ...updates.brain } : current.brain,
    mail: updates.mail ? { ...current.mail, ...updates.mail } : current.mail,
    terminal: updates.terminal ? { ...current.terminal, ...updates.terminal } : current.terminal,
    docs: updates.docs ? { ...current.docs, ...updates.docs } : current.docs,
    defaults: updates.defaults ? { ...current.defaults, ...updates.defaults } : current.defaults,
    compression: compression ? { ...current.compression, ...compression } : current.compression,
  };

  if (automations) {
    updated.automations = {
      enabled: automations.enabled ?? current.automations.enabled,
      refactorLargeFiles: {
        enabled: automations.refactorLargeFiles?.enabled ?? current.automations.refactorLargeFiles.enabled,
        minIntervalHours: automations.refactorLargeFiles?.minIntervalHours ?? current.automations.refactorLargeFiles.minIntervalHours,
        lastRunAt: automations.refactorLargeFiles?.lastRunAt ?? current.automations.refactorLargeFiles.lastRunAt,
        requireEmptyQueue: automations.refactorLargeFiles?.requireEmptyQueue ?? current.automations.refactorLargeFiles.requireEmptyQueue,
      },
    };
  }

  if (gitea) {
    updated.gitea = {
      url: gitea.url ?? current.gitea?.url ?? "",
      token: gitea.token ?? current.gitea?.token ?? "",
      defaultOrg: gitea.defaultOrg ?? current.gitea?.defaultOrg ?? "",
      defaultRepo: gitea.defaultRepo ?? current.gitea?.defaultRepo ?? "",
    };
  }
  
  // Write back to TOML
  const toml = configToToml(updated);
  await writeTomlConfig(toml, dir);
  
  return updated;
}
