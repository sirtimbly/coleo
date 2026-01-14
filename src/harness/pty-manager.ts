/**
 * PTY Session Manager
 * 
 * Manages pseudo-terminal sessions for controlling AI agents.
 * Uses bun-pty for Bun-native PTY support.
 */

import { spawn } from "bun-pty";
import type { IPty } from "bun-pty";
import type { PTYSession, TerminalKey } from "./types";
import { KEY_SEQUENCES } from "./types";

/**
 * Strip ANSI escape codes for text analysis
 * Handles CSI sequences, OSC sequences, and other terminal escapes
 */
export function stripAnsi(text: string): string {
  return text
    // CSI sequences: ESC [ ... letter
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // OSC sequences: ESC ] ... BEL or ESC ] ... ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Other single-char escape sequences
    .replace(/\x1b[^[\]]/g, "")
    // Control characters (keep newlines and tabs)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Parse terminal output into lines
 */
export function parseTerminalOutput(raw: string): string[] {
  const stripped = stripAnsi(raw);
  return stripped.split("\n").filter(line => line.trim() !== "");
}

/**
 * PTY Manager - handles spawning and interacting with PTY sessions
 */
export class PTYManager {
  /**
   * Spawn a new PTY session
   */
  spawn(
    command: string,
    args: string[],
    config: { workdir: string; env: Record<string, string> }
  ): PTYSession {
    // Merge env, filtering out undefined values (bun-pty is strict about types)
    const mergedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        mergedEnv[key] = value;
      }
    }
    for (const [key, value] of Object.entries(config.env)) {
      if (value !== undefined) {
        mergedEnv[key] = value;
      }
    }

    const ptyProcess = spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: config.workdir,
      env: mergedEnv,
    });

    const session: PTYSession = {
      pty: ptyProcess,
      buffer: "",
      lineBuffer: [],
      lastActivity: new Date(),
    };

    ptyProcess.onData((data: string) => {
      session.buffer += data;
      session.lastActivity = new Date();

      // Parse into lines
      const lines = parseTerminalOutput(data);
      session.lineBuffer.push(...lines);

      // Keep buffer from growing indefinitely (last 50KB)
      if (session.buffer.length > 50000) {
        session.buffer = session.buffer.slice(-40000);
      }
      if (session.lineBuffer.length > 1000) {
        session.lineBuffer = session.lineBuffer.slice(-800);
      }

      // Call user callback if set
      if (session.onData) {
        session.onData(data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (session.onExit) {
        session.onExit(exitCode);
      }
    });

    return session;
  }

  /**
   * Write text to the PTY
   */
  write(session: PTYSession, text: string): void {
    session.pty.write(text);
  }

  /**
   * Send a special key to the PTY
   */
  sendKey(session: PTYSession, key: TerminalKey): void {
    session.pty.write(KEY_SEQUENCES[key]);
  }

  /**
   * Resize the PTY
   */
  resize(session: PTYSession, cols: number, rows: number): void {
    session.pty.resize(cols, rows);
  }

  /**
   * Kill the PTY process
   */
  kill(session: PTYSession): void {
    session.pty.kill();
  }

  /**
   * Get the PID of the PTY process
   */
  getPid(session: PTYSession): number {
    return session.pty.pid;
  }

  /**
   * Wait for a pattern to appear in the output
   */
  async waitForPattern(
    session: PTYSession,
    pattern: RegExp,
    timeoutMs: number = 30000
  ): Promise<string> {
    const startTime = Date.now();
    const startIndex = session.buffer.length;

    return new Promise((resolve, reject) => {
      const check = () => {
        const newContent = session.buffer.slice(startIndex);
        const strippedContent = stripAnsi(newContent);
        
        if (pattern.test(strippedContent)) {
          resolve(strippedContent);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Timeout waiting for pattern: ${pattern}`));
          return;
        }

        setTimeout(check, 100);
      };

      check();
    });
  }

  /**
   * Wait for the terminal to be quiet (no output for a period)
   */
  async waitForQuiet(
    session: PTYSession,
    quietMs: number = 2000,
    timeoutMs: number = 60000
  ): Promise<void> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const check = () => {
        const timeSinceActivity = Date.now() - session.lastActivity.getTime();

        if (timeSinceActivity >= quietMs) {
          resolve();
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          reject(new Error("Timeout waiting for quiet"));
          return;
        }

        setTimeout(check, 100);
      };

      check();
    });
  }

  /**
   * Get recent output (stripped of ANSI codes)
   */
  getRecentOutput(session: PTYSession, chars: number = 500): string {
    return stripAnsi(session.buffer.slice(-chars));
  }

  /**
   * Clear the buffer
   */
  clearBuffer(session: PTYSession): void {
    session.buffer = "";
    session.lineBuffer = [];
  }
}

// Singleton instance
export const ptyManager = new PTYManager();
