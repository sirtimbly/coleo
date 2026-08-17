/**
 * API Configuration
 */

import { getColeoDir } from "../config";
import { resolveApiHost, resolveApiKey, resolveApiPort } from "../network-config";
import { join } from "path";

export type LogLevel = "quiet" | "normal" | "verbose";

export interface ApiConfig {
  port: number;
  host: string;
  apiKey: string;
  corsOrigins: string[];
  dbPath: string;
  logLevel: LogLevel;
}

/**
 * Load configuration from environment variables
 */
export function loadApiConfig(): ApiConfig {
  const apiKey = resolveApiKey();
  return {
    port: resolveApiPort(),
    host: resolveApiHost(),
    apiKey: apiKey || generateDevApiKey(),
    corsOrigins: (process.env.COLEO_CORS_ORIGINS || "http://localhost:5173,http://localhost:3000").split(","),
    dbPath: process.env.COLEO_DB_PATH || getDefaultDbPath(),
    logLevel: (process.env.COLEO_LOG_LEVEL || "quiet") as LogLevel,
  };
}

/**
 * Check if we should log at a given level
 */
export function shouldLog(level: LogLevel, messageLevel: LogLevel): boolean {
  const levels: Record<LogLevel, number> = { quiet: 0, normal: 1, verbose: 2 };
  return levels[messageLevel] <= levels[level];
}

/**
 * Generate a dev API key (printed to console on startup)
 */
function generateDevApiKey(): string {
  return `dev-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Get default database path
 */
function getDefaultDbPath(): string {
  return join(getColeoDir(), "coleo.db");
}
