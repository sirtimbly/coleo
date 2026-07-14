import { Hono } from "hono";

import { getColeoDir } from "../../config";
import { LocalRepositoryOnboarding } from "../../onboarding/local";
import { parseRepositoryOnboardingOperation } from "../../onboarding/types";
import { getArmClient } from "../arm-client-registry";
import { HttpError } from "../middleware";

import type {
  LocalRepositoryOnboardingOptions,
  RepositoryOnboardingService,
} from "../../onboarding/local";
import type {
  RepositoryOnboardingOperation,
  RepositoryOnboardingStatus,
} from "../../onboarding/types";

export type OnboardingStatus = RepositoryOnboardingStatus;

export interface OnboardingRouteOptions {
  projectDir?: string;
  coleoDir?: string;
  runCommand?: LocalRepositoryOnboardingOptions["runCommand"];
  repositoryService?: RepositoryOnboardingService;
}

function resolveProjectDir(explicit?: string): string {
  return explicit
    || process.env.COLEO_WORKDIR?.trim()
    || process.env.COLEO_PROJECT_DIR?.trim()
    || process.env.COLEO_REMOTE_WORKDIR?.trim()
    || process.cwd();
}

function resolveWorkspaceAgentId(): string {
  return process.env.COLEO_WORKSPACE_AGENT_ID?.trim()
    || (process.env.COLEO_PROJECT_ID ? `reef-${process.env.COLEO_PROJECT_ID}` : "");
}

class ArmHostRepositoryOnboarding implements RepositoryOnboardingService {
  private readonly agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  async execute(operation: RepositoryOnboardingOperation): Promise<RepositoryOnboardingStatus> {
    const armClient = getArmClient();
    if (!armClient) {
      throw new HttpError(503, "Arm Host connection is not available");
    }

    const agent = armClient.getAgent(this.agentId);
    if (!agent) {
      throw new HttpError(503, "Arm Host is not connected yet");
    }
    if (!agent.capabilities.includes("repository-onboarding")) {
      throw new HttpError(503, "Arm Host does not support repository onboarding; deploy the current Arm Host image");
    }

    const timeoutMs = operation.type === "clone" ? 120000 : 30000;
    const response = await armClient.executeRepositoryOnboarding(this.agentId, operation, timeoutMs);
    if (!response.success || !response.data) {
      const message = response.error || "Arm Host repository onboarding failed";
      if (operation.type === "clone") {
        throw HttpError.badRequest(message);
      }
      throw new HttpError(503, message);
    }
    return response.data;
  }
}

function createRepositoryService(options: OnboardingRouteOptions): RepositoryOnboardingService {
  if (options.repositoryService) return options.repositoryService;

  if (process.env.COLEO_REMOTE_ARMS_ONLY === "1") {
    const agentId = resolveWorkspaceAgentId();
    if (!agentId) {
      return {
        execute: async () => {
          throw new HttpError(503, "Arm Host workspace ID is not configured");
        },
      };
    }
    return new ArmHostRepositoryOnboarding(agentId);
  }

  return new LocalRepositoryOnboarding({
    projectDir: resolveProjectDir(options.projectDir),
    coleoDir: options.coleoDir || getColeoDir(),
    runCommand: options.runCommand,
  });
}

export function createOnboardingRoutes(options: OnboardingRouteOptions = {}) {
  const app = new Hono();
  const repositoryService = createRepositoryService(options);

  app.get("/", async (c) => c.json(await repositoryService.execute({ type: "status" })));

  app.post("/ssh-key", async (c) => {
    try {
      return c.json(await repositoryService.execute({ type: "generate_ssh_key" }));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : "Failed to generate SSH key";
      throw HttpError.internal(message);
    }
  });

  app.post("/clone", async (c) => {
    const body = await c.req.json<{
      repositoryUrl?: unknown;
      branch?: unknown;
    }>();
    let operation: RepositoryOnboardingOperation;
    try {
      operation = parseRepositoryOnboardingOperation({ type: "clone", ...body });
    } catch (error) {
      throw HttpError.badRequest(error instanceof Error ? error.message : "Invalid repository clone request");
    }

    try {
      return c.json(await repositoryService.execute(operation));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : "Failed to clone repository";
      throw HttpError.badRequest(message);
    }
  });

  return app;
}
