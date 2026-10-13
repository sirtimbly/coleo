import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  isGitRef,
  isRepositoryUrl,
  isSshRepositoryUrl,
} from "./types";

import type {
  RepositoryCheckoutCommit,
  RepositoryOnboardingOperation,
  RepositoryOnboardingStatus,
} from "./types";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RepositoryOnboardingService {
  execute(operation: RepositoryOnboardingOperation): Promise<RepositoryOnboardingStatus>;
}

export interface LocalRepositoryOnboardingOptions {
  projectDir: string;
  coleoDir: string;
  runCommand?: (command: string[], env?: Record<string, string>) => Promise<CommandResult>;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function directoryHasContents(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return (await readdir(path)).length > 0;
}

export class LocalRepositoryOnboarding implements RepositoryOnboardingService {
  private readonly projectDir: string;
  private readonly sshDir: string;
  private readonly privateKeyPath: string;
  private readonly publicKeyPath: string;
  private readonly knownHostsPath: string;
  private readonly runCommand: NonNullable<LocalRepositoryOnboardingOptions["runCommand"]>;
  private cloneInProgress = false;

  constructor(options: LocalRepositoryOnboardingOptions) {
    this.projectDir = options.projectDir;
    this.sshDir = join(options.coleoDir, "ssh");
    this.privateKeyPath = join(this.sshDir, "id_ed25519");
    this.publicKeyPath = `${this.privateKeyPath}.pub`;
    this.knownHostsPath = join(this.sshDir, "known_hosts");
    this.runCommand = options.runCommand || defaultRunCommand;
  }

  async execute(operation: RepositoryOnboardingOperation): Promise<RepositoryOnboardingStatus> {
    switch (operation.type) {
      case "status":
        return this.getStatus();
      case "generate_ssh_key":
        await this.generateSshKey();
        return this.getStatus();
      case "clone":
        await this.clone(operation.repositoryUrl, operation.branch);
        return this.getStatus();
    }
  }

  private async getStatus(): Promise<RepositoryOnboardingStatus> {
    const checkedOut = existsSync(join(this.projectDir, ".git"));
    const configured = existsSync(this.privateKeyPath) && existsSync(this.publicKeyPath);
    let publicKey: string | null = null;
    let remoteUrl: string | null = null;
    let branch: string | null = null;
    let commit: RepositoryCheckoutCommit | null = null;
    let trackedFileCount: number | null = null;
    let dirtyFileCount: number | null = null;
    let topLevelEntries: string[] = [];

    if (configured) {
      publicKey = (await Bun.file(this.publicKeyPath).text()).trim();
    }

    if (checkedOut) {
      const [remoteResult, branchResult, logResult, filesResult, porcelainResult, treeResult] = await Promise.all([
        this.runCommand(["git", "-C", this.projectDir, "remote", "get-url", "origin"]),
        this.runCommand(["git", "-C", this.projectDir, "branch", "--show-current"]),
        this.runCommand(["git", "-C", this.projectDir, "log", "-1", "--format=%H%x00%h%x00%an%x00%aI%x00%s"]),
        this.runCommand(["git", "-C", this.projectDir, "ls-files"]),
        this.runCommand(["git", "-C", this.projectDir, "status", "--porcelain"]),
        this.runCommand(["git", "-C", this.projectDir, "ls-tree", "HEAD"]),
      ]);
      remoteUrl = remoteResult.exitCode === 0 && remoteResult.stdout ? remoteResult.stdout : null;
      branch = branchResult.exitCode === 0 && branchResult.stdout ? branchResult.stdout : null;

      if (logResult.exitCode === 0 && logResult.stdout) {
        const [hash, shortHash, author, date, subject] = logResult.stdout.split("\0");
        if (hash && shortHash) {
          commit = { hash, shortHash, author: author ?? "", date: date ?? "", subject: subject ?? "" };
        }
      }

      if (filesResult.exitCode === 0) {
        trackedFileCount = filesResult.stdout ? filesResult.stdout.split("\n").length : 0;
      }

      if (porcelainResult.exitCode === 0) {
        dirtyFileCount = porcelainResult.stdout ? porcelainResult.stdout.split("\n").length : 0;
      }

      if (treeResult.exitCode === 0 && treeResult.stdout) {
        topLevelEntries = treeResult.stdout.split("\n").map((line) => {
          const match = line.match(/^\d+ (\w+) [0-9a-f]+\t(.+)$/);
          if (!match) return null;
          return match[1] === "tree" ? `${match[2]}/` : match[2];
        }).filter((entry): entry is string => entry !== null);
      }
    }

    return {
      ready: checkedOut,
      projectDir: this.projectDir,
      repository: { checkedOut, remoteUrl, branch, commit, trackedFileCount, dirtyFileCount, topLevelEntries },
      ssh: { configured, publicKey },
    };
  }

  private async generateSshKey(): Promise<void> {
    await mkdir(this.sshDir, { recursive: true, mode: 0o700 });
    await chmod(this.sshDir, 0o700);

    if (!existsSync(this.privateKeyPath) || !existsSync(this.publicKeyPath)) {
      await rm(this.privateKeyPath, { force: true });
      await rm(this.publicKeyPath, { force: true });
      const result = await this.runCommand([
        "ssh-keygen",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "coleo-project-access",
        "-f",
        this.privateKeyPath,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to generate SSH key: ${result.stderr || "ssh-keygen failed"}`);
      }
    }

    await chmod(this.privateKeyPath, 0o600);
    await chmod(this.publicKeyPath, 0o644);
  }

  private async clone(repositoryUrl: string, branch?: string): Promise<void> {
    const normalizedUrl = repositoryUrl.trim();
    const normalizedBranch = branch?.trim() || "";
    if (!isRepositoryUrl(normalizedUrl)) {
      throw new Error("Enter a valid HTTPS or SSH Git repository URL");
    }
    if (normalizedBranch && !isGitRef(normalizedBranch)) {
      throw new Error("Enter a valid branch, tag, or commit name");
    }
    if (this.cloneInProgress) {
      throw new Error("A repository clone is already in progress");
    }

    this.cloneInProgress = true;
    try {
      if (existsSync(join(this.projectDir, ".git"))) {
        throw new Error("A Git repository is already checked out in the project directory");
      }
      if (isSshRepositoryUrl(normalizedUrl) && !existsSync(this.privateKeyPath)) {
        throw new Error("Generate an SSH key before cloning an SSH repository");
      }
      if (await directoryHasContents(this.projectDir)) {
        throw new Error(`Project directory is not empty: ${this.projectDir}`);
      }

      await mkdir(this.projectDir, { recursive: true });
      const sshCommand = this.getSshCommand();
      const result = await this.runCommand(
        ["git", "clone", "--", normalizedUrl, this.projectDir],
        { GIT_SSH_COMMAND: sshCommand },
      );
      if (result.exitCode !== 0) {
        await this.resetProjectDirectory();
        throw new Error(`Git clone failed: ${result.stderr || "unknown Git error"}`);
      }

      if (normalizedBranch) {
        const checkoutResult = await this.runCommand([
          "git",
          "-C",
          this.projectDir,
          "checkout",
          normalizedBranch,
        ]);
        if (checkoutResult.exitCode !== 0) {
          await this.resetProjectDirectory();
          throw new Error(`Git checkout failed: ${checkoutResult.stderr || "unknown Git error"}`);
        }
      }

      if (existsSync(this.privateKeyPath)) {
        const configResult = await this.runCommand([
          "git",
          "-C",
          this.projectDir,
          "config",
          "core.sshCommand",
          sshCommand,
        ]);
        if (configResult.exitCode !== 0) {
          await this.resetProjectDirectory();
          throw new Error(`Repository cloned, but SSH configuration failed: ${configResult.stderr}`);
        }
      }
    } finally {
      this.cloneInProgress = false;
    }
  }

  private getSshCommand(): string {
    return [
      "ssh",
      "-i",
      shellQuote(this.privateKeyPath),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      shellQuote(`UserKnownHostsFile=${this.knownHostsPath}`),
    ].join(" ");
  }

  private async resetProjectDirectory(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true });
    const entries = await readdir(this.projectDir);
    await Promise.all(entries.map((entry) => (
      rm(join(this.projectDir, entry), { recursive: true, force: true })
    )));
  }
}
