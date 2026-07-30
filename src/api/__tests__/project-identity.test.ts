import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

import { detectProjectName } from "../routes/system";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.length = 0;
});

describe("project identity", () => {
  it("uses the package manifest name", () => {
    const directory = mkdtempSync(join(tmpdir(), "coleo-project-name-"));
    directories.push(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "customer-dashboard" }));

    expect(detectProjectName(directory)).toBe("customer-dashboard");
  });

  it("falls back to the workspace directory name", () => {
    const directory = mkdtempSync(join(tmpdir(), "coleo-project-name-"));
    directories.push(directory);

    expect(detectProjectName(directory)).toBe(basename(directory));
  });
});
