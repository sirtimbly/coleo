/**
 * Compression Config Module Tests
 *
 * Tests for config loading, threshold behavior, and backward compatibility.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
	DEFAULT_COMPRESSION_CONFIG,
	loadCompressionConfig,
	getCompressionConfigFromEnv,
	getStatusEmoji,
	getStatusDescription,
	formatThresholds,
	shouldCompress,
	validateCompressionConfig,
	type CompressionConfig,
} from "../compression";

describe("Compression Config Module", () => {
	describe("DEFAULT_COMPRESSION_CONFIG", () => {
		it("should have default values matching original hardcoded thresholds", () => {
			expect(DEFAULT_COMPRESSION_CONFIG.warningThreshold).toBe(80);
			expect(DEFAULT_COMPRESSION_CONFIG.criticalThreshold).toBe(95);
			expect(DEFAULT_COMPRESSION_CONFIG.maxThreshold).toBe(100);
			expect(DEFAULT_COMPRESSION_CONFIG.enabled).toBe(true);
		});
	});

	describe("getCompressionConfigFromEnv", () => {
		const originalEnv = process.env;

		beforeEach(() => {
			process.env = { ...originalEnv };
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		it("should return defaults when no env vars are set", () => {
			delete process.env.COLEO_COMPRESSION_WARNING_THRESHOLD;
			delete process.env.COLEO_COMPRESSION_CRITICAL_THRESHOLD;
			delete process.env.COLEO_COMPRESSION_MAX_THRESHOLD;
			delete process.env.COLEO_COMPRESSION_ENABLED;

			const config = getCompressionConfigFromEnv();
			expect(config).toEqual(DEFAULT_COMPRESSION_CONFIG);
		});

		it("should read warning threshold from env", () => {
			process.env.COLEO_COMPRESSION_WARNING_THRESHOLD = "70";
			const config = getCompressionConfigFromEnv();
			expect(config.warningThreshold).toBe(70);
			expect(config.criticalThreshold).toBe(
				DEFAULT_COMPRESSION_CONFIG.criticalThreshold
			);
		});

		it("should read critical threshold from env", () => {
			process.env.COLEO_COMPRESSION_CRITICAL_THRESHOLD = "90";
			const config = getCompressionConfigFromEnv();
			expect(config.criticalThreshold).toBe(90);
			expect(config.warningThreshold).toBe(
				DEFAULT_COMPRESSION_CONFIG.warningThreshold
			);
		});

		it("should read max threshold from env", () => {
			process.env.COLEO_COMPRESSION_MAX_THRESHOLD = "98";
			const config = getCompressionConfigFromEnv();
			expect(config.maxThreshold).toBe(98);
		});

		it("should read enabled from env", () => {
			process.env.COLEO_COMPRESSION_ENABLED = "false";
			const config = getCompressionConfigFromEnv();
			expect(config.enabled).toBe(false);
		});

		it("should handle all env vars together", () => {
			process.env.COLEO_COMPRESSION_WARNING_THRESHOLD = "75";
			process.env.COLEO_COMPRESSION_CRITICAL_THRESHOLD = "88";
			process.env.COLEO_COMPRESSION_MAX_THRESHOLD = "99";
			process.env.COLEO_COMPRESSION_ENABLED = "false";

			const config = getCompressionConfigFromEnv();
			expect(config.warningThreshold).toBe(75);
			expect(config.criticalThreshold).toBe(88);
			expect(config.maxThreshold).toBe(99);
			expect(config.enabled).toBe(false);
		});

		it("should handle enabled=true string", () => {
			process.env.COLEO_COMPRESSION_ENABLED = "true";
			const config = getCompressionConfigFromEnv();
			expect(config.enabled).toBe(true);
		});

		it("should handle invalid enabled values as false", () => {
			process.env.COLEO_COMPRESSION_ENABLED = "invalid";
			const config = getCompressionConfigFromEnv();
			expect(config.enabled).toBe(false);
		});
	});

	describe("getStatusEmoji", () => {
		const config: CompressionConfig = {
			warningThreshold: 80,
			criticalThreshold: 95,
			maxThreshold: 100,
			enabled: true,
		};

		it("should return ✅ for usage at or below warning threshold", () => {
			expect(getStatusEmoji(0, config)).toBe("✅");
			expect(getStatusEmoji(50, config)).toBe("✅");
			expect(getStatusEmoji(79, config)).toBe("✅");
			expect(getStatusEmoji(80, config)).toBe("✅");  // At threshold is still OK
		});

		it("should return ⚠️ for usage above warning but at or below critical", () => {
			expect(getStatusEmoji(81, config)).toBe("⚠️");
			expect(getStatusEmoji(90, config)).toBe("⚠️");
			expect(getStatusEmoji(94, config)).toBe("⚠️");
			expect(getStatusEmoji(95, config)).toBe("⚠️");  // At critical threshold is still warning
		});

		it("should return 🔥 for usage above critical but at or below max", () => {
			expect(getStatusEmoji(96, config)).toBe("🔥");
			expect(getStatusEmoji(99, config)).toBe("🔥");
			expect(getStatusEmoji(100, config)).toBe("🔥");  // At max threshold is critical
		});

		it("should return 🔴 for usage above max", () => {
			expect(getStatusEmoji(101, config)).toBe("🔴");
		});

		it("should use defaults when config is not provided", () => {
			expect(getStatusEmoji(50)).toBe("✅");
			expect(getStatusEmoji(85)).toBe("⚠️");
			expect(getStatusEmoji(97)).toBe("🔥");
			expect(getStatusEmoji(101)).toBe("🔴");
		});

		it("should work with custom thresholds", () => {
			const customConfig: CompressionConfig = {
				warningThreshold: 60,
				criticalThreshold: 80,
				maxThreshold: 100,
				enabled: true,
			};
			expect(getStatusEmoji(50, customConfig)).toBe("✅");
			expect(getStatusEmoji(70, customConfig)).toBe("⚠️");
			expect(getStatusEmoji(90, customConfig)).toBe("🔥");
		});
	});

	describe("getStatusDescription", () => {
		const config: CompressionConfig = {
			warningThreshold: 80,
			criticalThreshold: 95,
			maxThreshold: 100,
			enabled: true,
		};

		it("should return 'Healthy' for usage below warning", () => {
			expect(getStatusDescription(50, config)).toBe("Healthy");
		});

		it("should return warning description at warning threshold", () => {
			expect(getStatusDescription(80, config)).toBe(
				"Warning - consider completing or compressing"
			);
		});

		it("should return critical description at critical threshold", () => {
			expect(getStatusDescription(95, config)).toBe(
				"Hard limit - compression will trigger"
			);
		});

		it("should return max description at max threshold", () => {
			expect(getStatusDescription(100, config)).toBe(
				"Maximum - forced compression or task handoff"
			);
		});
	});

	describe("formatThresholds", () => {
		it("should format thresholds with default values", () => {
			const result = formatThresholds();
			expect(result).toContain("80%: Warning");
			expect(result).toContain("95%: Hard limit");
			expect(result).toContain("100%: Maximum");
		});

		it("should format thresholds with custom values", () => {
			const customConfig: CompressionConfig = {
				warningThreshold: 70,
				criticalThreshold: 85,
				maxThreshold: 95,
				enabled: true,
			};
			const result = formatThresholds(customConfig);
			expect(result).toContain("70%: Warning");
			expect(result).toContain("85%: Hard limit");
			expect(result).toContain("95%: Maximum");
		});
	});

	describe("shouldCompress", () => {
		const config: CompressionConfig = {
			warningThreshold: 80,
			criticalThreshold: 95,
			maxThreshold: 100,
			enabled: true,
		};

		it("should return false when compression is disabled", () => {
			const disabledConfig = { ...config, enabled: false };
			expect(shouldCompress(100, disabledConfig)).toBe(false);
		});

		it("should return false when usage is below critical threshold", () => {
			expect(shouldCompress(80, config)).toBe(false);
			expect(shouldCompress(94, config)).toBe(false);
		});

		it("should return true when usage reaches critical threshold", () => {
			expect(shouldCompress(95, config)).toBe(true);
		});

		it("should return true when usage exceeds critical threshold", () => {
			expect(shouldCompress(96, config)).toBe(true);
			expect(shouldCompress(100, config)).toBe(true);
		});

		it("should use defaults when config is not provided", () => {
			expect(shouldCompress(94)).toBe(false);
			expect(shouldCompress(95)).toBe(true);
		});
	});

	describe("validateCompressionConfig", () => {
		it("should return null for valid config", () => {
			expect(
				validateCompressionConfig({
					warningThreshold: 70,
					criticalThreshold: 85,
					maxThreshold: 100,
				})
			).toBeNull();
		});

		it("should return null for valid partial config", () => {
			expect(validateCompressionConfig({ warningThreshold: 75 })).toBeNull();
		});

		it("should return null for empty config", () => {
			expect(validateCompressionConfig({})).toBeNull();
		});

		it("should error when warningThreshold is negative", () => {
			expect(
				validateCompressionConfig({ warningThreshold: -1 })
			).toContain("between 0 and 100");
		});

		it("should error when warningThreshold is over 100", () => {
			expect(
				validateCompressionConfig({ warningThreshold: 101 })
			).toContain("between 0 and 100");
		});

		it("should error when criticalThreshold is negative", () => {
			expect(
				validateCompressionConfig({ criticalThreshold: -5 })
			).toContain("between 0 and 100");
		});

		it("should error when maxThreshold is over 100", () => {
			expect(
				validateCompressionConfig({ maxThreshold: 150 })
			).toContain("between 0 and 100");
		});

		it("should error when warningThreshold >= criticalThreshold", () => {
			expect(
				validateCompressionConfig({
					warningThreshold: 90,
					criticalThreshold: 90,
				})
			).toContain("less than criticalThreshold");
		});

		it("should error when warningThreshold > criticalThreshold", () => {
			expect(
				validateCompressionConfig({
					warningThreshold: 95,
					criticalThreshold: 80,
				})
			).toContain("less than criticalThreshold");
		});

		it("should error when criticalThreshold >= maxThreshold", () => {
			expect(
				validateCompressionConfig({
					criticalThreshold: 100,
					maxThreshold: 100,
				})
			).toContain("less than maxThreshold");
		});

		it("should allow valid threshold ordering", () => {
			expect(
				validateCompressionConfig({
					warningThreshold: 70,
					criticalThreshold: 85,
					maxThreshold: 100,
				})
			).toBeNull();
		});
	});

	describe("Backward Compatibility", () => {
		it("DEFAULT_COMPRESSION_CONFIG should match original hardcoded values", () => {
			// These values were hardcoded in get_context_budget tool
			expect(DEFAULT_COMPRESSION_CONFIG.warningThreshold).toBe(80);
			expect(DEFAULT_COMPRESSION_CONFIG.criticalThreshold).toBe(95);
			expect(DEFAULT_COMPRESSION_CONFIG.maxThreshold).toBe(100);
		});

		it("should work without any configuration (uses defaults)", () => {
			const config = getCompressionConfigFromEnv();
			expect(getStatusEmoji(50, config)).toBe("✅");
			expect(getStatusEmoji(85, config)).toBe("⚠️");
			expect(getStatusEmoji(97, config)).toBe("🔥");
		});
	});

	describe("Integration with ColeoConfig types", () => {
		it("should have same defaults as types/DEFAULT_CONFIG", async () => {
			const { DEFAULT_CONFIG } = await import("../../../types");
			expect(DEFAULT_COMPRESSION_CONFIG.warningThreshold).toBe(
				DEFAULT_CONFIG.compression.warningThreshold
			);
			expect(DEFAULT_COMPRESSION_CONFIG.criticalThreshold).toBe(
				DEFAULT_CONFIG.compression.criticalThreshold
			);
			expect(DEFAULT_COMPRESSION_CONFIG.maxThreshold).toBe(
				DEFAULT_CONFIG.compression.maxThreshold
			);
			expect(DEFAULT_COMPRESSION_CONFIG.enabled).toBe(
				DEFAULT_CONFIG.compression.enabled
			);
		});
	});
});
