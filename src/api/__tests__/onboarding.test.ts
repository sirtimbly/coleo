import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import { formatErrorResponse } from "../middleware/error";
import { createOnboardingRoutes } from "../routes/onboarding";

import type { OnboardingStatus } from "../routes/onboarding";

describe("onboarding routes", () => {
  let rootDir: string;
  let projectDir: string;
  let coleoDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "coleo-onboarding-"));
    projectDir = join(rootDir, "project");
    coleoDir = join(rootDir, ".coleo");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("requires onboarding when the project directory is not a Git checkout", async () => {
    const app = new Hono();
    app.route("/api/onboarding", createOnboardingRoutes({ projectDir, coleoDir }));

    const response = await app.request("http://localhost/api/onboarding");
    const body = await response.json() as OnboardingStatus;

    expect(response.status).toBe(200);
    expect(body.ready).toBe(false);
    expect(body.projectDir).toBe(projectDir);
    expect(body.repository.checkedOut).toBe(false);
    expect(body.ssh.configured).toBe(false);
  });

  it("reports repository metadata for an existing checkout", async () => {
    await mkdir(join(projectDir, ".git"), { recursive: true });
    const app = new Hono();
    app.route("/api/onboarding", createOnboardingRoutes({
      projectDir,
      coleoDir,
      runCommand: async (command) => ({
        exitCode: 0,
        stdout: command.includes("get-url") ? "git@example.com:team/project.git" : "main",
        stderr: "",
      }),
    }));

    const response = await app.request("http://localhost/api/onboarding");
    const body = await response.json() as OnboardingStatus;

    expect(body.ready).toBe(true);
    expect(body.repository).toEqual({
      checkedOut: true,
      remoteUrl: "git@example.com:team/project.git",
      branch: "main",
    });
  });

  it("generates a persistent key and clones with the configured SSH command", async () => {
    const commands: Array<{ command: string[]; env?: Record<string, string> }> = [];
    const privateKeyPath = join(coleoDir, "ssh", "id_ed25519");
    const app = new Hono();
    app.onError((error, c) => formatErrorResponse(c, error));
    app.route("/api/onboarding", createOnboardingRoutes({
      projectDir,
      coleoDir,
      runCommand: async (command, env) => {
        commands.push({ command, env });
        if (command[0] === "ssh-keygen") {
          await writeFile(privateKeyPath, "private-key");
          await writeFile(`${privateKeyPath}.pub`, "ssh-ed25519 public-key coleo-project-access\n");
        } else if (command[0] === "git" && command[1] === "clone") {
          await mkdir(join(projectDir, ".git"), { recursive: true });
        }

        if (command.includes("get-url")) {
          return { exitCode: 0, stdout: "git@example.com:team/project.git", stderr: "" };
        }
        if (command.includes("--show-current")) {
          return { exitCode: 0, stdout: "main", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }));

    const keyResponse = await app.request("http://localhost/api/onboarding/ssh-key", {
      method: "POST",
    });
    const keyBody = await keyResponse.json() as OnboardingStatus;
    expect(keyResponse.status).toBe(200);
    expect(keyBody.ssh.publicKey).toBe("ssh-ed25519 public-key coleo-project-access");

    const cloneResponse = await app.request("http://localhost/api/onboarding/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryUrl: "git@example.com:team/project.git",
        branch: "main",
      }),
    });
    const cloneBody = await cloneResponse.json() as OnboardingStatus;

    expect(cloneResponse.status).toBe(200);
    expect(cloneBody.ready).toBe(true);
    const cloneCall = commands.find(({ command }) => command[0] === "git" && command[1] === "clone");
    expect(cloneCall?.command).toEqual([
      "git",
      "clone",
      "--",
      "git@example.com:team/project.git",
      projectDir,
    ]);
    expect(cloneCall?.env?.GIT_SSH_COMMAND).toContain(privateKeyPath);
    expect(commands.some(({ command }) => (
      command[0] === "git" && command.includes("checkout") && command.at(-1) === "main"
    ))).toBe(true);
  });

  it("rejects invalid repository URLs before running Git", async () => {
    const app = new Hono();
    app.onError((error, c) => formatErrorResponse(c, error));
    app.route("/api/onboarding", createOnboardingRoutes({ projectDir, coleoDir }));

    const response = await app.request("http://localhost/api/onboarding/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "not a repository" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Enter a valid HTTPS or SSH Git repository URL" });
  });
});
