import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  getProjectCollectionName,
  getProjectDurableName,
  getProjectRuntimeEnvironment,
  getProjectScope,
  getTranscriptCollectionName,
  resolveProjectDirectory,
} from "../../project-scope";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
  directories.length = 0;
});

describe("project scope", () => {
  it("canonicalizes symlinked project directories to one partition", () => {
    const parent = mkdtempSync(join(tmpdir(), "coleo-project-scope-"));
    directories.push(parent);
    const project = join(parent, "project");
    const link = join(parent, "project-link");
    mkdirSync(project);
    symlinkSync(project, link, "dir");

    expect(resolveProjectDirectory({ COLEO_PROJECT_DIR: link }, parent)).toBe(realpathSync.native(project));
    expect(getProjectScope({ COLEO_PROJECT_DIR: link }, parent).projectKey).toBe(
      getProjectScope({ COLEO_PROJECT_DIR: project }, parent).projectKey,
    );
  });

  it("uses different collection names for different project directories", () => {
    const first = getProjectScope({ COLEO_PROJECT_DIR: "/workspace/one" }, "/");
    const second = getProjectScope({ COLEO_PROJECT_DIR: "/workspace/two" }, "/");

    expect(first.projectKey).not.toBe(second.projectKey);
    expect(getProjectCollectionName("search-index", first)).not.toBe(
      getProjectCollectionName("search-index", second),
    );
    expect(getProjectCollectionName("search-index", first)).not.toContain(first.projectDir);
    expect(getTranscriptCollectionName({ COLEO_PROJECT_DIR: first.projectDir }, first)).toBe(
      getProjectCollectionName("search-index", first),
    );
    expect(getProjectDurableName("indexer", first)).toBe(`indexer-${first.projectKey}`);
  });

  it("propagates the project root and project-local NATS port to child processes", () => {
    const runtimeEnv = getProjectRuntimeEnvironment({
      COLEO_PROJECT_DIR: "/workspace/one",
      COLEO_API_TOKEN: "co_legacy",
      COLEO_NATS_PORT: "4223",
    }, "/");

    expect(runtimeEnv).toEqual({
      COLEO_PROJECT_DIR: "/workspace/one",
      COLEO_API_URL: "http://127.0.0.1:8080",
      COLEO_API_KEY: "co_legacy",
      COLEO_NATS_URL: "nats://127.0.0.1:4223",
      COLEO_NATS_PORT: "4223",
    });
  });
});
