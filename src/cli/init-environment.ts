import { randomBytes } from "crypto";
import { createServer } from "net";

import { createProjectKey } from "../project-scope";

export interface ColeoMiseEnvironment {
  COLEO_PROJECT_DIR: string;
  COLEO_API_HOST: string;
  COLEO_API_PORT: string;
  COLEO_NATS_HOST: string;
  COLEO_NATS_PORT: string;
  COLEO_NATS_HTTP_PORT: string;
  COLEO_API_KEY: string;
}

type PortAvailabilityCheck = (port: number, host: string) => Promise<boolean>;

const COLEO_ENV_KEYS = [
  "COLEO_PROJECT_DIR",
  "COLEO_API_HOST",
  "COLEO_API_PORT",
  "COLEO_NATS_HOST",
  "COLEO_NATS_PORT",
  "COLEO_NATS_HTTP_PORT",
  "COLEO_API_KEY",
] as const;

export function generateApiKey(): string {
  return `co_${randomBytes(32).toString("hex")}`;
}

export async function createColeoMiseEnvironment(
  projectDir: string,
  existing: Partial<ColeoMiseEnvironment> = {},
  isAvailable: PortAvailabilityCheck = isPortAvailable,
): Promise<ColeoMiseEnvironment> {
  const apiHost = existing.COLEO_API_HOST || "127.0.0.1";
  const natsHost = existing.COLEO_NATS_HOST || "127.0.0.1";
  const offset = Number.parseInt(createProjectKey(projectDir).slice(0, 8), 16) % 1000;
  const reserved = new Set<number>();

  const apiPort = await resolvePort(existing.COLEO_API_PORT, 18_000 + offset, apiHost, reserved, isAvailable);
  const natsPort = await resolvePort(existing.COLEO_NATS_PORT, 20_000 + offset, natsHost, reserved, isAvailable);
  const natsHttpPort = await resolvePort(
    existing.COLEO_NATS_HTTP_PORT,
    22_000 + offset,
    natsHost,
    reserved,
    isAvailable,
  );

  return {
    COLEO_PROJECT_DIR: existing.COLEO_PROJECT_DIR || projectDir,
    COLEO_API_HOST: apiHost,
    COLEO_API_PORT: String(apiPort),
    COLEO_NATS_HOST: natsHost,
    COLEO_NATS_PORT: String(natsPort),
    COLEO_NATS_HTTP_PORT: String(natsHttpPort),
    COLEO_API_KEY: existing.COLEO_API_KEY || generateApiKey(),
  };
}

export function readColeoMiseEnvironment(content: string): Partial<ColeoMiseEnvironment> {
  const section = findTomlSection(content, "env");
  if (!section) return {};

  const values: Partial<ColeoMiseEnvironment> = {};
  for (const key of COLEO_ENV_KEYS) {
    const match = section.content.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']\\s*$`, "m"));
    if (match?.[1]) values[key] = match[1];
  }
  return values;
}

export function updateMiseToml(content: string, values: ColeoMiseEnvironment): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  let next = content;
  let section = findTomlSection(next, "env");

  if (!section) {
    const separator = next.length === 0 || next.endsWith(lineEnding) ? "" : lineEnding;
    next += `${separator}${next.length > 0 ? lineEnding : ""}[env]${lineEnding}`;
    section = findTomlSection(next, "env");
  }

  if (!section) throw new Error("Unable to create [env] section in mise.toml");

  const missing: string[] = [];
  for (const key of COLEO_ENV_KEYS) {
    const value = quoteToml(values[key]);
    const keyPattern = new RegExp(`^(\\s*${key}\\s*=).*$`, "m");
    const sectionContent = next.slice(section.start, section.end);
    if (keyPattern.test(sectionContent)) {
      const updatedSection = sectionContent.replace(keyPattern, `$1 ${value}`);
      next = next.slice(0, section.start) + updatedSection + next.slice(section.end);
      section = findTomlSection(next, "env");
      if (!section) throw new Error("Unable to update [env] section in mise.toml");
    } else {
      missing.push(`${key} = ${value}`);
    }
  }

  if (missing.length > 0) {
    section = findTomlSection(next, "env");
    if (!section) throw new Error("Unable to update [env] section in mise.toml");
    const insertion = [
      "# Project-local Coleo endpoints prevent local projects from sharing API or JetStream state.",
      ...missing,
      "",
    ].join(lineEnding);
    const prefix = section.content.endsWith(lineEnding) ? "" : lineEnding;
    next = next.slice(0, section.end) + prefix + insertion + next.slice(section.end);
  }

  return next;
}

export function readEnvValue(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*["']?([^\\s"']+)["']?\\s*$`, "m"));
  return match?.[1];
}

async function resolvePort(
  configured: string | undefined,
  start: number,
  host: string,
  reserved: Set<number>,
  isAvailable: PortAvailabilityCheck,
): Promise<number> {
  const configuredPort = Number.parseInt(configured || "", 10);
  if (configuredPort > 0 && configuredPort <= 65_535 && !reserved.has(configuredPort)) {
    reserved.add(configuredPort);
    return configuredPort;
  }

  for (let offset = 0; offset < 1000; offset++) {
    const candidate = start + offset;
    if (!reserved.has(candidate) && await isAvailable(candidate, host)) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw new Error(`No available local port found near ${start}`);
}

function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function findTomlSection(content: string, name: string): {
  start: number;
  end: number;
  content: string;
} | null {
  const headerPattern = new RegExp(`^\\[${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\]\\s*$`, "m");
  const match = headerPattern.exec(content);
  if (!match || match.index === undefined) return null;

  const bodyStart = match.index + match[0].length;
  const nextSection = /^\s*\[[^\]]+\]\s*$/m.exec(content.slice(bodyStart));
  const end = nextSection?.index === undefined ? content.length : bodyStart + nextSection.index;
  return {
    start: match.index,
    end,
    content: content.slice(match.index, end),
  };
}

function quoteToml(value: string): string {
  return JSON.stringify(value);
}
