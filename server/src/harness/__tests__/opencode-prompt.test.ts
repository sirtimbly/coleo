import { describe, expect, it, spyOn } from "bun:test";
import { OpenCodeHarness } from "../opencode";
import { PTYManager } from "../pty-manager";
import type { HarnessSession } from "../types";

describe("OpenCode terminal prompt delivery", () => {
  it("submits a multiline startup prompt with blank lines without empty native writes", async () => {
    const writes: string[] = [];
    const session = {
      id: "test-arm",
      pty: {
        buffer: "Ask anything",
        pty: {
          write(text: string) {
            if (!text.length) throw new Error("Native PTY rejects empty buffers");
            writes.push(text);
          },
        },
      },
    } as unknown as HarnessSession;
    const ready = spyOn(PTYManager.prototype, "waitForPattern").mockResolvedValue("Ask anything");
    try {
      await new OpenCodeHarness().sendPrompt(session, "Read the plan.\n\nClaim a task.\n");
    } finally {
      ready.mockRestore();
    }
    expect(writes).toEqual(["\x1b[200~Read the plan.\n\nClaim a task.\n\x1b[201~", "\r"]);
  });

  it("ignores empty PTY writes but preserves whitespace", () => {
    const writes: string[] = [];
    const session = { pty: { write: (text: string) => writes.push(text) } } as unknown as HarnessSession["pty"];
    const manager = new PTYManager();
    manager.write(session, "");
    manager.write(session, " ");
    expect(writes).toEqual([" "]);
  });
});
