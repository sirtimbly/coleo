/**
 * Compression Configuration Module
 * 
 * Provides access to compression settings from config
 */

import { loadConfig } from "../config/loader";
import { DEFAULT_CONFIG } from "../types";
import type { ColeoConfig } from "../types";

let cachedConfig: ColeoConfig["compression"] | null = null;

/**
 * Get compression configuration
 * Loads from config file or returns defaults
 */
export async function getCompressionConfig(): Promise<ColeoConfig["compression"]> {
	if (cachedConfig) {
		return cachedConfig;
	}

	try {
		const config = await loadConfig();
		cachedConfig = config.compression;
		return cachedConfig;
	} catch {
		// Return defaults if config can't be loaded
		return DEFAULT_CONFIG.compression;
	}
}

/**
 * Get compression thresholds
 */
export async function getCompressionThresholds(): Promise<{
	warning: number;
	softLimit: number;
	hardLimit: number;
}> {
	const config = await getCompressionConfig();
	return config.thresholds;
}

/**
 * Check if compression is enabled
 */
export async function isCompressionEnabled(): Promise<boolean> {
	const config = await getCompressionConfig();
	return config.enabled;
}

/**
 * Get compression strategy
 */
export async function getCompressionStrategy(): Promise<
	"aggressive" | "balanced" | "conservative"
> {
	const config = await getCompressionConfig();
	return config.strategy;
}

/**
 * Get removal priority order
 */
export async function getRemovalPriority(): Promise<
	Array<"history" | "artifacts" | "notes" | "tools" | "context">
> {
	const config = await getCompressionConfig();
	return config.removalPriority;
}

/**
 * Check if auto-compress is enabled
 */
export async function isAutoCompressEnabled(): Promise<boolean> {
	const config = await getCompressionConfig();
	return config.autoCompress;
}

/**
 * Check if notifications are enabled
 */
export async function isNotifyOnCompressionEnabled(): Promise<boolean> {
	const config = await getCompressionConfig();
	return config.notifyOnCompression;
}

/**
 * Get minimum tokens to keep after compression
 */
export async function getMinTokensAfterCompression(): Promise<number> {
	const config = await getCompressionConfig();
	return config.minTokensAfterCompression;
}

/**
 * Clear cached config (for testing or config reloads)
 */
export function clearCompressionConfigCache(): void {
	cachedConfig = null;
}

/**
 * Get strategy-specific settings
 */
export function getStrategySettings(
	strategy: "aggressive" | "balanced" | "conservative",
): {
	compressAtPercent: number;
	maxRemovalPercent: number;
	description: string;
} {
	switch (strategy) {
		case "aggressive":
			return {
				compressAtPercent: 70,
				maxRemovalPercent: 60,
				description: "Compress early, remove more content for speed",
			};
		case "conservative":
			return {
				compressAtPercent: 90,
				maxRemovalPercent: 20,
				description: "Compress late, preserve more content",
			};
		case "balanced":
		default:
			return {
				compressAtPercent: 80,
				maxRemovalPercent: 40,
				description: "Balance between speed and content retention",
			};
	}
}

/**
 * Check if compression should trigger based on usage
 */
export async function shouldCompress(
	usagePercent: number,
): Promise<{ shouldCompress: boolean; reason: string }> {
	const config = await getCompressionConfig();

	if (!config.enabled) {
		return { shouldCompress: false, reason: "Compression disabled" };
	}

	if (!config.autoCompress) {
		return { shouldCompress: false, reason: "Auto-compress disabled" };
	}

	const strategy = getStrategySettings(config.strategy);

	if (usagePercent >= config.thresholds.hardLimit * 100) {
		return { shouldCompress: true, reason: "Hard limit reached" };
	}

	if (usagePercent >= config.thresholds.softLimit * 100) {
		return { shouldCompress: true, reason: "Soft limit reached" };
	}

	if (usagePercent >= strategy.compressAtPercent) {
		return { shouldCompress: true, reason: `Strategy threshold (${config.strategy})` };
	}

	return { shouldCompress: false, reason: "Below threshold" };
}

/**
 * Get threshold status for a given usage percent
 */
export async function getThresholdStatus(
	usagePercent: number,
): Promise<{
	status: "ok" | "warning" | "critical" | "exceeded";
	emoji: string;
	message: string;
}> {
	const thresholds = await getCompressionThresholds();

	if (usagePercent >= thresholds.hardLimit * 100) {
		return {
			status: "exceeded",
			emoji: "🔥",
			message: "Hard limit exceeded - compression required",
		};
	}

	if (usagePercent >= thresholds.softLimit * 100) {
		return {
			status: "critical",
			emoji: "⚠️",
			message: "Soft limit reached - compression recommended",
		};
	}

	if (usagePercent >= thresholds.warning * 100) {
		return {
			status: "warning",
			emoji: "⚡",
			message: "Warning - consider compressing soon",
		};
	}

	return {
		status: "ok",
		emoji: "✅",
		message: "Within budget",
	};
}
