/**
 * Harness Registry
 * 
 * Manages available agent harnesses and provides a factory for creating them.
 */

import type { AgentHarness } from "./types";
import { OpenCodeHarness } from "./opencode";
import { OpenCodeApiHarness } from "./opencode-api";

export type HarnessType = "opencode" | "opencode-api" | "claude-code" | "aider" | "custom";

/**
 * Registry of available harnesses
 */
class HarnessRegistry {
  private harnesses = new Map<string, () => AgentHarness>();

  constructor() {
    // Register default harnesses
    this.register("opencode", () => new OpenCodeHarness());
    this.register("opencode-api", () => new OpenCodeApiHarness());
    // TODO: Add more harnesses as they're implemented
    // this.register("claude-code", () => new ClaudeCodeHarness());
    // this.register("aider", () => new AiderHarness());
  }

  /**
   * Register a harness factory
   */
  register(name: string, factory: () => AgentHarness): void {
    this.harnesses.set(name, factory);
  }

  /**
   * Get a harness by name
   */
  get(name: string): AgentHarness {
    const factory = this.harnesses.get(name);
    if (!factory) {
      throw new Error(`Unknown harness: ${name}. Available: ${this.list().join(", ")}`);
    }
    return factory();
  }

  /**
   * Check if a harness is available
   */
  has(name: string): boolean {
    return this.harnesses.has(name);
  }

  /**
   * List all available harnesses
   */
  list(): string[] {
    return Array.from(this.harnesses.keys());
  }
}

// Singleton registry
export const harnessRegistry = new HarnessRegistry();
