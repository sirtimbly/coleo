/**
 * Configuration Module
 * 
 * Exports configuration loading and management utilities.
 */

export {
  loadConfig,
  updateConfig,
  readTomlConfig,
  writeTomlConfig,
  configToToml,
  getColeoDir,
  getConfigPath,
} from "./loader";

export {
  getPreferredModels,
  getRandomPreferredModel,
  parseModelSpec,
  formatModelSpec,
  type ModelSpec,
} from "./models";

export {
  DEFAULT_ARM_TEMPLATES,
  ensureDefaultArmTemplates,
  type DefaultArmTemplateSeedResult,
} from "./default-arm-templates";
