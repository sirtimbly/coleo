import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerArmCommands } from "../commands/arm";

describe("supported CLI harness selection", () => {
  for (const args of [["--harness", "opencode"], ["--harness", "opencode-tui"], ["--terminal", "ghostty"]]) {
    it(`rejects ${args.join(" ")} before spawning`, async () => {
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      registerArmCommands(program);
      await expect(program.parseAsync(["arm", "spawn", ...args], { from: "user" })).rejects.toThrow();
    });
  }
});
