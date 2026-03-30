import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadArmTemplates } from "../helpers/prompts";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("loadArmTemplates", () => {
  it("parses provider and model defaults from template files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coleo-arm-templates-"));
    tempDirs.push(dir);

    writeFileSync(
      join(dir, "default.toml"),
      [
        "[arm]",
        'name = "default"',
        'domain = "development"',
        "",
        "[model]",
        'provider = "openai"',
        'model = "gpt-5.2-codex"',
        "",
      ].join("\n"),
    );

    const templates = await loadArmTemplates(dir);

    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      file: "default.toml",
      provider: "openai",
      model: "gpt-5.2-codex",
    });
  });
});
