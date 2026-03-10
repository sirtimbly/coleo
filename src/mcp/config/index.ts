/**
 * MCP Configuration Module
 *
 * Exports configuration utilities for MCP tools.
 */

export {
  DEFAULT_COMPRESSION_CONFIG,
  loadCompressionConfig,
  getCompressionConfigFromEnv,
  getStatusEmoji,
  getStatusDescription,
  formatThresholds,
  shouldCompress,
  validateCompressionConfig,
  type CompressionConfig,
} from "./compression";
