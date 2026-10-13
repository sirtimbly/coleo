import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

import { detectProjectName } from "../routes/system";
import { getServerWorkspaceRoot } from "../workspace-access";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.length = 0;
});

describe("project identity", () => {
  it("uses the exact folder name even when the package name differs", () => {
    const directory = mkdtempSync(join(tmpdir(), "coleo-project-name-"));
    directories.push(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "customer-dashboard" }));

    expect(detectProjectName(directory)).toBe(basename(directory));
  });

  it("falls back to the workspace directory name", () => {
    const directory = mkdtempSync(join(tmpdir(), "coleo-project-name-"));
    directories.push(directory);

    expect(detectProjectName(directory)).toBe(basename(directory));
  });
});


describe("workspace identity root", () => {
  const originalProjectDir = process.env.COLEO_PROJECT_DIR;
  const originalRemoteWorkdir = process.env.COLEO_REMOTE_WORKDIR;

  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.COLEO_PROJECT_DIR;
    else process.env.COLEO_PROJECT_DIR = originalProjectDir;
    if (originalRemoteWorkdir === undefined) delete process.env.COLEO_REMOTE_WORKDIR;
    else process.env.COLEO_REMOTE_WORKDIR = originalRemoteWorkdir;
  });

  it("uses the configured project directory ahead of the server and remote directories", () => {
    process.env.COLEO_PROJECT_DIR = "/projects/My Project";
    process.env.COLEO_REMOTE_WORKDIR = "/remote/workspace";
    expect(getServerWorkspaceRoot()).toBe("/projects/My Project");
    expect(detectProjectName(getServerWorkspaceRoot())).toBe("My Project");
  });

  it("uses the hosted workspace without reading local package metadata", () => {
    delete process.env.COLEO_PROJECT_DIR;
    process.env.COLEO_REMOTE_WORKDIR = "/remote/customer-checkout/";
    expect(getServerWorkspaceRoot()).toBe("/remote/customer-checkout/");
    expect(detectProjectName(getServerWorkspaceRoot())).toBe("customer-checkout");
  });

  it("uses the process directory when no workspace is configured", () => {
    delete process.env.COLEO_PROJECT_DIR;
    delete process.env.COLEO_REMOTE_WORKDIR;
    expect(getServerWorkspaceRoot()).toBe(process.cwd());
  });
});
