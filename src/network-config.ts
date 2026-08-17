export const DEFAULT_API_BIND_HOST = "0.0.0.0";
export const DEFAULT_API_CLIENT_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 8080;
export const DEFAULT_NATS_HOST = "127.0.0.1";
export const DEFAULT_NATS_PORT = 4222;
export const DEFAULT_NATS_HTTP_PORT = 8222;

export function resolveApiHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLEO_API_HOST?.trim() || DEFAULT_API_BIND_HOST;
}

export function resolveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort(env.COLEO_API_PORT, DEFAULT_API_PORT);
}

export function resolveApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configuredUrl = env.COLEO_API_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");

  const host = normalizeClientHost(env.COLEO_API_HOST?.trim() || DEFAULT_API_CLIENT_HOST);
  return `http://${formatUrlHost(host)}:${resolveApiPort(env)}`;
}

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.COLEO_API_KEY?.trim() || env.COLEO_API_TOKEN?.trim() || undefined;
}

export function resolveNatsHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLEO_NATS_HOST?.trim() || DEFAULT_NATS_HOST;
}

export function resolveNatsPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort(env.COLEO_NATS_PORT, DEFAULT_NATS_PORT);
}

export function resolveNatsHttpPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort(env.COLEO_NATS_HTTP_PORT, DEFAULT_NATS_HTTP_PORT);
}

export function resolveNatsUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configuredUrl = env.COLEO_NATS_URL?.trim();
  if (configuredUrl) return configuredUrl;

  return `nats://${formatUrlHost(resolveNatsHost(env))}:${resolveNatsPort(env)}`;
}

function normalizeClientHost(host: string): string {
  if (host === "0.0.0.0") return DEFAULT_API_CLIENT_HOST;
  if (host === "::") return "::1";
  return host;
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
}
