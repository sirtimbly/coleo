/**
 * Terminal Detector
 *
 * Functions for detecting terminal emulators and headless environments.
 */

import { promisify } from "util";
import { exec } from "child_process";
import type { TerminalEmulator } from "./spawner-types";

const execAsync = promisify(exec);

/**
 * Detect if we're running in a headless environment (no display)
 */
export function isHeadlessEnvironment(): boolean {
  // Docker containers typically don't have DISPLAY
  // Also check for common container indicators
  return (
    !process.env.DISPLAY &&
    (process.env.container !== undefined ||
      process.env.DOCKER === "true" ||
      Bun.file("/.dockerenv").size > 0 ||
      process.env.SSH_CONNECTION !== undefined)
  );
}

/**
 * Detect which terminal emulator is available
 */
export async function detectTerminal(): Promise<TerminalEmulator> {
  // In headless environments, prefer tmux if available, otherwise headless
  if (isHeadlessEnvironment()) {
    try {
      await execAsync("which tmux");
      return "tmux";
    } catch {
      return "headless";
    }
  }

  const terminals: Array<{ name: TerminalEmulator; check: string }> = [
    { name: "ghostty", check: "which ghostty" },
    { name: "wezterm", check: "which wezterm" },
    { name: "kitty", check: "which kitty" },
    { name: "iterm2", check: "ls /Applications/iTerm.app" },
    { name: "terminal", check: "ls /System/Applications/Utilities/Terminal.app" },
  ];

  for (const { name, check } of terminals) {
    try {
      await execAsync(check);
      return name;
    } catch {
      continue;
    }
  }

  return "terminal"; // Fallback to Terminal.app
}

/**
 * Get the command to launch a terminal with a specific command
 */
export async function getTerminalCommand(
  terminal: TerminalEmulator,
  command: string,
  title: string,
  workdir: string
): Promise<{ cmd: string; args: string[] }> {
  switch (terminal) {
    case "ghostty":
      // Ghostty on macOS works best with open command
      // We wrap in bash -c to handle environment variables properly
      return {
        cmd: "ghostty",
        args: [
          `--title=${title}`,
          `--working-directory=${workdir}`,
          "-e", "bash", "-c", command,
        ],
      };

    case "wezterm":
      return {
        cmd: "wezterm",
        args: [
          "start",
          "--cwd", workdir,
          "--", "bash", "-c", command,
        ],
      };

    case "kitty":
      return {
        cmd: "kitty",
        args: [
          "--title", title,
          "--directory", workdir,
          "bash", "-c", command,
        ],
      };

    case "iterm2":
      // iTerm2 requires AppleScript
      {
        const script = `
          tell application "iTerm2"
            create window with default profile
            tell current session of current window
              write text "cd ${workdir} && ${command}"
            end tell
          end tell
        `;
        return {
          cmd: "osascript",
          args: ["-e", script],
        };
      }

    case "terminal":
    default:
      // Terminal.app also uses AppleScript
      {
        const termScript = `
          tell application "Terminal"
            do script "cd ${workdir} && ${command}"
            activate
          end tell
        `;
        return {
          cmd: "osascript",
          args: ["-e", termScript],
        };
      }

    case "tmux":
      // Create a new tmux session for the arm
      return {
        cmd: "tmux",
        args: [
          "new-session",
          "-d",  // Detached
          "-s", title.replace(/[^a-zA-Z0-9_-]/g, "_"),  // Session name (sanitized)
          "-c", workdir,
          command,
        ],
      };

    case "headless":
      // Run directly as a background process, logging to file
      {
        const { getColeoDir } = await import("../config");
        const { join } = await import("path");
        const logFile = join(process.env.COLEO_DIR || getColeoDir(), "logs", `${title}.log`);
        return {
          cmd: "bash",
          args: [
            "-c",
            `mkdir -p "$(dirname "${logFile}")" && cd "${workdir}" && ${command} >> "${logFile}" 2>&1`,
          ],
        };
      }
  }
}
