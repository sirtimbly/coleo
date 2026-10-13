import { describe, expect, it } from "bun:test";

import { OpenCodeApiHarness } from "../opencode-api";

describe("OpenCodeApiHarness interrupt", () => {
  it("aborts before submitting the replacement prompt", async () => {
    const harness = new OpenCodeApiHarness();
    const session = { id: "harness-session" };
    const calls: string[] = [];
    let promptBody: Record<string, unknown> | undefined;
    const internals = harness as unknown as {
      sessions: Map<string, unknown>;
    };
    internals.sessions.set(session.id, {
      sessionId: "opencode-session",
      client: {
        session: {
          abort: async () => {
            calls.push("abort");
            return { data: true };
          },
          promptAsync: async (options: { body: Record<string, unknown> }) => {
            calls.push("promptAsync");
            promptBody = options.body;
            return { data: undefined };
          },
        },
      },
      pty: { lastActivity: new Date() },
    });

    await harness.sendPrompt(session as never, "Replacement prompt", {
      interrupt: true,
    });

    expect(calls).toEqual(["abort", "promptAsync"]);
    expect(promptBody).not.toHaveProperty("interrupt");
  });

  it("does not submit a prompt when the preceding abort fails", async () => {
    const harness = new OpenCodeApiHarness();
    const session = { id: "harness-session" };
    let promptSubmitted = false;
    const internals = harness as unknown as {
      sessions: Map<string, unknown>;
    };
    internals.sessions.set(session.id, {
      sessionId: "opencode-session",
      client: {
        session: {
          abort: async () => ({
            error: { name: "AbortError", data: { message: "session remained busy" } },
          }),
          promptAsync: async () => {
            promptSubmitted = true;
            return { data: undefined };
          },
        },
      },
      pty: { lastActivity: new Date() },
    });

    await expect(
      harness.sendPrompt(session as never, "Replacement prompt", { interrupt: true }),
    ).rejects.toThrow("AbortError: session remained busy");
    expect(promptSubmitted).toBe(false);
  });
});
