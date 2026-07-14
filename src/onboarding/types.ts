export interface RepositoryOnboardingStatus {
  ready: boolean;
  projectDir: string;
  repository: {
    checkedOut: boolean;
    remoteUrl: string | null;
    branch: string | null;
  };
  ssh: {
    configured: boolean;
    publicKey: string | null;
  };
}

export type RepositoryOnboardingOperation =
  | { type: "status" }
  | { type: "generate_ssh_key" }
  | { type: "clone"; repositoryUrl: string; branch?: string };

export function isRepositoryUrl(value: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/)[^\s]+$/.test(value)
    || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(value);
}

export function isSshRepositoryUrl(value: string): boolean {
  return value.startsWith("ssh://") || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(value);
}

export function isGitRef(value: string): boolean {
  return value.length <= 255
    && !value.startsWith("-")
    && !value.includes("..")
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

export function parseRepositoryOnboardingOperation(value: unknown): RepositoryOnboardingOperation {
  if (!value || typeof value !== "object") {
    throw new Error("Repository onboarding operation must be an object");
  }

  const input = value as Record<string, unknown>;
  if (input.type === "status" || input.type === "generate_ssh_key") {
    return { type: input.type };
  }
  if (input.type !== "clone") {
    throw new Error(`Unsupported repository onboarding operation: ${String(input.type)}`);
  }
  if (typeof input.repositoryUrl !== "string" || !isRepositoryUrl(input.repositoryUrl.trim())) {
    throw new Error("Enter a valid HTTPS or SSH Git repository URL");
  }
  if (input.branch !== undefined && typeof input.branch !== "string") {
    throw new Error("Repository branch must be a string");
  }

  const branch = input.branch?.trim() || "";
  if (branch && !isGitRef(branch)) {
    throw new Error("Enter a valid branch, tag, or commit name");
  }

  return {
    type: "clone",
    repositoryUrl: input.repositoryUrl.trim(),
    branch: branch || undefined,
  };
}
