/**
 * Terminal Detection
 * 
 * Detects and configures terminal emulators for spawning arms.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { getColeoDir } from "../config";
import type { TerminalEmulator } from "./spawner-types";

const execAsync = promisify(exec);

/**
 * Detect if we're running in a headless environment (no display)
 */
export function isHeadlessEnvironment(): boolean {
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

  return "terminal";
}

/**
 * Get the command to launch a terminal with a specific command
 */
export function getTerminalCommand(
  terminal: TerminalEmulator,
  command: string,
  title: string,
  workdir: string
): { cmd: string; args: string[] } {
  switch (terminal) {
    case "ghostty":
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
      return {
        cmd: "tmux",
        args: [
          "new-session",
          "-d",
          "-s", title.replace(/[^a-zA-Z0-9_-]/g, "_"),
          "-c", workdir,
          command,
        ],
      };

    case "headless":
      {
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
