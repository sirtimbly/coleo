/**
 * API Configuration
 */

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
  return {
    port: parseInt(process.env.OCTOPAI_API_PORT || "8080", 10),
    host: process.env.OCTOPAI_API_HOST || "0.0.0.0",
    apiKey: process.env.OCTOPAI_API_KEY || generateDevApiKey(),
    corsOrigins: (process.env.OCTOPAI_CORS_ORIGINS || "http://localhost:5173,http://localhost:3000").split(","),
    dbPath: process.env.OCTOPAI_DB_PATH || getDefaultDbPath(),
    logLevel: (process.env.OCTOPAI_LOG_LEVEL || "quiet") as LogLevel,
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
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return `${home}/.octopai/octopai.db`;
}
