import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { Hono } from "hono";

import { getColeoDir } from "../../config";
import { HttpError } from "../middleware";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface OnboardingStatus {
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

export interface OnboardingRouteOptions {
  projectDir?: string;
  coleoDir?: string;
  runCommand?: (command: string[], env?: Record<string, string>) => Promise<CommandResult>;
}

function resolveProjectDir(explicit?: string): string {
  return explicit
    || process.env.COLEO_WORKDIR?.trim()
    || process.env.COLEO_PROJECT_DIR?.trim()
    || process.cwd();
}

async function defaultRunCommand(
  command: string[],
  env: Record<string, string> = {},
): Promise<CommandResult> {
  const processHandle = Bun.spawn(command, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function isRepositoryUrl(value: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/)[^\s]+$/.test(value)
    || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(value);
}

function isSshRepositoryUrl(value: string): boolean {
  return value.startsWith("ssh://") || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(value);
}

function isGitRef(value: string): boolean {
  return value.length <= 255
    && !value.startsWith("-")
    && !value.includes("..")
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function directoryHasContents(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return (await readdir(path)).length > 0;
}

export function createOnboardingRoutes(options: OnboardingRouteOptions = {}) {
  const app = new Hono();
  const projectDir = resolveProjectDir(options.projectDir);
  const coleoDir = options.coleoDir || getColeoDir();
  const sshDir = join(coleoDir, "ssh");
  const privateKeyPath = join(sshDir, "id_ed25519");
  const publicKeyPath = `${privateKeyPath}.pub`;
  const knownHostsPath = join(sshDir, "known_hosts");
  const runCommand = options.runCommand || defaultRunCommand;

  const getStatus = async (): Promise<OnboardingStatus> => {
    const checkedOut = existsSync(join(projectDir, ".git"));
    const configured = existsSync(privateKeyPath) && existsSync(publicKeyPath);
    let publicKey: string | null = null;
    let remoteUrl: string | null = null;
    let branch: string | null = null;

    if (configured) {
      publicKey = (await Bun.file(publicKeyPath).text()).trim();
    }

    if (checkedOut) {
      const [remoteResult, branchResult] = await Promise.all([
        runCommand(["git", "-C", projectDir, "remote", "get-url", "origin"]),
        runCommand(["git", "-C", projectDir, "branch", "--show-current"]),
      ]);
      remoteUrl = remoteResult.exitCode === 0 && remoteResult.stdout ? remoteResult.stdout : null;
      branch = branchResult.exitCode === 0 && branchResult.stdout ? branchResult.stdout : null;
    }

    return {
      ready: checkedOut,
      projectDir,
      repository: { checkedOut, remoteUrl, branch },
      ssh: { configured, publicKey },
    };
  };

  app.get("/", async (c) => c.json(await getStatus()));

  app.post("/ssh-key", async (c) => {
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    await chmod(sshDir, 0o700);

    if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
      await rm(privateKeyPath, { force: true });
      await rm(publicKeyPath, { force: true });
      const result = await runCommand([
        "ssh-keygen",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "coleo-project-access",
        "-f",
        privateKeyPath,
      ]);
      if (result.exitCode !== 0) {
        throw HttpError.internal(`Failed to generate SSH key: ${result.stderr || "ssh-keygen failed"}`);
      }
    }

    await chmod(privateKeyPath, 0o600);
    await chmod(publicKeyPath, 0o644);
    return c.json(await getStatus());
  });

  app.post("/clone", async (c) => {
    if (existsSync(join(projectDir, ".git"))) {
      throw HttpError.badRequest("A Git repository is already checked out in the project directory");
    }

    const body = await c.req.json<{ repositoryUrl?: string; branch?: string }>();
    const repositoryUrl = body.repositoryUrl?.trim() || "";
    const branch = body.branch?.trim() || "";

    if (!isRepositoryUrl(repositoryUrl)) {
      throw HttpError.badRequest("Enter a valid HTTPS or SSH Git repository URL");
    }
    if (branch && !isGitRef(branch)) {
      throw HttpError.badRequest("Enter a valid branch, tag, or commit name");
    }
    if (isSshRepositoryUrl(repositoryUrl)) {
      if (!existsSync(privateKeyPath)) {
        throw HttpError.badRequest("Generate an SSH key before cloning an SSH repository");
      }
    }
    if (await directoryHasContents(projectDir)) {
      throw HttpError.badRequest(`Project directory is not empty: ${projectDir}`);
    }

    await mkdir(projectDir, { recursive: true });
    const cloneCommand = ["git", "clone"];
    cloneCommand.push("--", repositoryUrl, projectDir);

    const sshCommand = [
      "ssh",
      "-i",
      shellQuote(privateKeyPath),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      shellQuote(`UserKnownHostsFile=${knownHostsPath}`),
    ].join(" ");
    const result = await runCommand(cloneCommand, { GIT_SSH_COMMAND: sshCommand });
    if (result.exitCode !== 0) {
      await rm(projectDir, { recursive: true, force: true });
      throw HttpError.badRequest(`Git clone failed: ${result.stderr || "unknown Git error"}`);
    }

    if (branch) {
      const checkoutResult = await runCommand(["git", "-C", projectDir, "checkout", "--", branch]);
      if (checkoutResult.exitCode !== 0) {
        await rm(projectDir, { recursive: true, force: true });
        throw HttpError.badRequest(`Git checkout failed: ${checkoutResult.stderr || "unknown Git error"}`);
      }
    }

    if (existsSync(privateKeyPath)) {
      const configResult = await runCommand([
        "git",
        "-C",
        projectDir,
        "config",
        "core.sshCommand",
        sshCommand,
      ]);
      if (configResult.exitCode !== 0) {
        throw HttpError.internal(`Repository cloned, but SSH configuration failed: ${configResult.stderr}`);
      }
    }

    return c.json(await getStatus());
  });

  return app;
}
