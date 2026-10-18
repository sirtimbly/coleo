/**
 * Compression Configuration Module
 *
 * Provides centralized access to compression settings and thresholds.
 * Used by MCP tools to determine when context compression should trigger.
 *
 * Priority: Environment > Config File > Defaults
 */

import { loadConfig, getColeoDir } from "../../config/loader";
import { DEFAULT_CONFIG } from "../../types";
import type { ColeoConfig } from "../../types";

/**
 * Compression configuration interface
 */
export interface CompressionConfig {
  /** Percentage at which warning status is shown (default: 80) */
  warningThreshold: number;
  /** Percentage at which critical/hard limit is reached (default: 95) */
  criticalThreshold: number;
  /** Maximum percentage before forced compression (default: 100) */
  maxThreshold: number;
  /** Whether compression is enabled (default: true) */
  enabled: boolean;
}

/**
 * Default compression configuration
 * Use these when no config is available (backward compatibility)
 */
export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  warningThreshold: 80,
  criticalThreshold: 95,
  maxThreshold: 100,
  enabled: true,
};

/**
 * Load compression configuration from Coleo config
 * Falls back to defaults if config cannot be loaded
 */
export async function loadCompressionConfig(
  coleoDir?: string
): Promise<CompressionConfig> {
  try {
    const config = await loadConfig(coleoDir);
    return config.compression;
  } catch {
    // If config fails to load, return defaults for backward compatibility
    return DEFAULT_COMPRESSION_CONFIG;
  }
}

/**
 * Synchronously get compression configuration from environment or defaults
 * Use this when async config loading is not possible
 */
export function getCompressionConfigFromEnv(): CompressionConfig {
  return {
    warningThreshold:
      process.env.COLEO_COMPRESSION_WARNING_THRESHOLD !== undefined
        ? parseInt(process.env.COLEO_COMPRESSION_WARNING_THRESHOLD, 10)
        : DEFAULT_COMPRESSION_CONFIG.warningThreshold,
    criticalThreshold:
      process.env.COLEO_COMPRESSION_CRITICAL_THRESHOLD !== undefined
        ? parseInt(process.env.COLEO_COMPRESSION_CRITICAL_THRESHOLD, 10)
        : DEFAULT_COMPRESSION_CONFIG.criticalThreshold,
    maxThreshold:
      process.env.COLEO_COMPRESSION_MAX_THRESHOLD !== undefined
        ? parseInt(process.env.COLEO_COMPRESSION_MAX_THRESHOLD, 10)
        : DEFAULT_COMPRESSION_CONFIG.maxThreshold,
    enabled:
      process.env.COLEO_COMPRESSION_ENABLED !== undefined
        ? process.env.COLEO_COMPRESSION_ENABLED === "true"
        : DEFAULT_COMPRESSION_CONFIG.enabled,
  };
}

/**
 * Get status emoji based on usage percentage and thresholds
 */
export function getStatusEmoji(
  usagePercent: number,
  config: CompressionConfig = DEFAULT_COMPRESSION_CONFIG
): string {
  if (usagePercent > config.maxThreshold) return "🔴";
  if (usagePercent > config.criticalThreshold) return "🔥";
  if (usagePercent > config.warningThreshold) return "⚠️";
  return "✅";
}

/**
 * Get human-readable status description based on usage percentage
 */
export function getStatusDescription(
  usagePercent: number,
  config: CompressionConfig = DEFAULT_COMPRESSION_CONFIG
): string {
  if (usagePercent >= config.maxThreshold) {
    return "Maximum - forced compression or task handoff";
  }
  if (usagePercent >= config.criticalThreshold) {
    return "Hard limit - compression will trigger";
  }
  if (usagePercent >= config.warningThreshold) {
    return "Warning - consider completing or compressing";
  }
  return "Healthy";
}

/**
 * Format threshold information for display
 */
export function formatThresholds(
  config: CompressionConfig = DEFAULT_COMPRESSION_CONFIG
): string {
  return (
    `**Thresholds:**\n` +
    `- ${config.warningThreshold}%: Warning - consider completing or compressing\n` +
    `- ${config.criticalThreshold}%: Hard limit - compression will trigger\n` +
    `- ${config.maxThreshold}%: Maximum - forced compression or task handoff`
  );
}

/**
 * Check if compression should be triggered based on usage
 */
export function shouldCompress(
  usagePercent: number,
  config: CompressionConfig = DEFAULT_COMPRESSION_CONFIG
): boolean {
  if (!config.enabled) return false;
  return usagePercent >= config.criticalThreshold;
}

/**
 * Validate compression configuration values
 * Returns null if valid, error message if invalid
 */
export function validateCompressionConfig(
  config: Partial<CompressionConfig>
): string | null {
  if (
    config.warningThreshold !== undefined &&
    (config.warningThreshold < 0 || config.warningThreshold > 100)
  ) {
    return "warningThreshold must be between 0 and 100";
  }
  if (
    config.criticalThreshold !== undefined &&
    (config.criticalThreshold < 0 || config.criticalThreshold > 100)
  ) {
    return "criticalThreshold must be between 0 and 100";
  }
  if (
    config.maxThreshold !== undefined &&
    (config.maxThreshold < 0 || config.maxThreshold > 100)
  ) {
    return "maxThreshold must be between 0 and 100";
  }
  if (
    config.warningThreshold !== undefined &&
    config.criticalThreshold !== undefined &&
    config.warningThreshold >= config.criticalThreshold
  ) {
    return "warningThreshold must be less than criticalThreshold";
  }
  if (
    config.criticalThreshold !== undefined &&
    config.maxThreshold !== undefined &&
    config.criticalThreshold >= config.maxThreshold
  ) {
    return "criticalThreshold must be less than maxThreshold";
  }
  return null;
}
