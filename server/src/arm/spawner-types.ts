/**
 * Spawner Types
 * 
 * Shared types for the arm spawning system.
 */

export type AgentType = "opencode" | "opencode-api" | "opencode-tui" | "claude-code" | "aider" | "custom";
export type TerminalEmulator = "auto" | "ghostty" | "iterm2" | "terminal" | "wezterm" | "kitty" | "headless" | "tmux" | "harness";

export interface SpawnOptions {
  coleoDir: string;
  name: string;
  agent: AgentType;
  workdir: string;
  terminal?: TerminalEmulator;
  customCommand?: string;
  initialPrompt?: string;
  /** Run in headless mode (no terminal window) - uses harness system */
  headless?: boolean;
  /** AI provider (e.g., "opencode", "github-copilot", "anthropic") */
  provider?: string;
  /** Model name (e.g., "claude-sonnet-4", "gpt-5.1-codex") */
  model?: string;
  /** Domain of expertise (e.g., "frontend", "backend", "testing") */
  domain?: string;
}
