import { createHash } from "crypto";
import { realpathSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { resolveApiKey, resolveApiUrl, resolveNatsUrl } from "./network-config";

export interface ProjectScope {
  projectDir: string;
  projectKey: string;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function resolveProjectDirectory(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured =
    env.COLEO_PROJECT_DIR?.trim() ||
    env.COLEO_WORKDIR?.trim() ||
    env.COLEO_REMOTE_WORKDIR?.trim() ||
    cwd;
  const absolute = resolve(cwd, expandHome(configured));

  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function createProjectKey(projectDir: string): string {
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
}

export function getProjectScope(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ProjectScope {
  const projectDir = resolveProjectDirectory(env, cwd);
  return {
    projectDir,
    projectKey: createProjectKey(projectDir),
  };
}

export function getProjectCollectionName(
  baseName: string,
  scope: ProjectScope = getProjectScope(),
): string {
  return `${baseName}-${scope.projectKey}`;
}

export function getTranscriptCollectionName(
  env: NodeJS.ProcessEnv = process.env,
  scope: ProjectScope = getProjectScope(env),
): string {
  return getProjectCollectionName(env.COLEO_TRANSCRIPT_COLLECTION?.trim() || "search-index", scope);
}

export function getProjectDurableName(
  baseName: string,
  scope: ProjectScope = getProjectScope(),
): string {
  return `${baseName}-${scope.projectKey}`;
}

export function getProjectRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Record<string, string> {
  const scope = getProjectScope(env, cwd);
  const apiKey = resolveApiKey(env);

  return {
    COLEO_PROJECT_DIR: scope.projectDir,
    COLEO_API_URL: resolveApiUrl(env),
    COLEO_NATS_URL: resolveNatsUrl(env),
    ...(env.COLEO_API_HOST ? { COLEO_API_HOST: env.COLEO_API_HOST } : {}),
    ...(env.COLEO_API_PORT ? { COLEO_API_PORT: env.COLEO_API_PORT } : {}),
    ...(apiKey ? { COLEO_API_KEY: apiKey } : {}),
    ...(env.COLEO_NATS_HOST ? { COLEO_NATS_HOST: env.COLEO_NATS_HOST } : {}),
    ...(env.COLEO_NATS_PORT ? { COLEO_NATS_PORT: env.COLEO_NATS_PORT } : {}),
    ...(env.COLEO_NATS_HTTP_PORT ? { COLEO_NATS_HTTP_PORT: env.COLEO_NATS_HTTP_PORT } : {}),
    ...(env.COLEO_NATS_TOKEN ? { COLEO_NATS_TOKEN: env.COLEO_NATS_TOKEN } : {}),
  };
}
