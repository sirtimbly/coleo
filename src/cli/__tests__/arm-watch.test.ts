import { describe, expect, it } from "bun:test";
import {
  buildAlignedArmLines,
  getWatchActivityAgeSeconds,
  formatWatchArmSelectionOption,
  formatWatchMessageTimestamp,
  getWatchFocusLine,
  getRenderableWatchMessageLines,
  resolveWatchArmName,
  settleWatchRefreshNotice,
} from "../commands/arm";

describe("arm watch rendering", () => {
  it("formats message timestamps with date and time", () => {
    expect(
      formatWatchMessageTimestamp(
        { created: 1770841191872 },
        { locale: "en-US", timeZone: "UTC" },
      ),
    ).toBe("02/11/2026, 20:19:51");
  });

  it("skips assistant messages with no displayable content", () => {
    expect(
      getRenderableWatchMessageLines([
        { type: "step-start" },
        { type: "reasoning", text: "internal reasoning" },
        { type: "text", text: "   " },
        { type: "step-finish" },
      ]),
    ).toEqual([]);
  });

  it("renders current tool parts from session messages", () => {
    expect(
      getRenderableWatchMessageLines([
        { type: "step-start" },
        {
          type: "tool",
          tool: "coleo_get_full_briefing",
          state: { status: "completed" },
        },
        { type: "step-finish" },
      ]),
    ).toEqual(["🔧 Tool: coleo_get_full_briefing [completed]"]);
  });

  it("respects --no-tools and still renders text parts", () => {
    expect(
      getRenderableWatchMessageLines(
        [
          { type: "tool", tool: "coleo_get_full_briefing", state: "completed" },
          { type: "text", text: "Claimed the next task." },
        ],
        { tools: false },
      ),
    ).toEqual(["Claimed the next task."]);
  });

  it("truncates long messages by default", () => {
    const longText = "a".repeat(520);
    expect(
      getRenderableWatchMessageLines([{ type: "text", text: longText }])[0],
    ).toContain("truncated");
  });

  it("can render full message bodies when truncation is disabled", () => {
    const longText = "a".repeat(520);
    expect(
      getRenderableWatchMessageLines(
        [{ type: "text", text: longText }],
        { truncateMessages: false },
      ),
    ).toEqual([longText]);
  });

  it("formats active arm picker options with status and task context", () => {
    expect(
      formatWatchArmSelectionOption({
        id: "arm-alpha",
        name: "arm-alpha",
        status: "busy",
        currentTaskSubject: "Investigate blank assistant blocks",
        runtime: {
          state: "active",
          secondsSinceOutput: 4,
        },
      }),
    ).toContain("arm-alpha |");
  });

  it("resolves a watch target from the active-arm picker when no name is given", async () => {
    const selected = await resolveWatchArmName(undefined, {
      interactive: true,
      color: false,
      fetchImpl: async () =>
        new Response(JSON.stringify({
          arms: [
            {
              id: "arm-alpha",
              name: "arm-alpha",
              status: "busy",
              currentTaskSubject: "Investigate blank assistant blocks",
              runtime: { state: "active", secondsSinceOutput: 4 },
            },
            {
              id: "arm-beta",
              name: "arm-beta",
              status: "idle",
              currentTaskSubject: "Waiting for follow-up",
              runtime: { state: "productive", secondsSinceOutput: 20 },
            },
          ],
        })),
      selectPrompt: async (_text, values) => values[1] || "",
      apiUrl: "http://coleo.test",
      headers: { "content-type": "application/json" },
    });

    expect(selected).toBe("arm-beta");
  });

  it("requires a name outside a TTY when multiple active arms exist", async () => {
    await expect(
      resolveWatchArmName(undefined, {
        interactive: false,
        fetchImpl: async () =>
          new Response(JSON.stringify({
            arms: [
              { id: "arm-alpha", name: "arm-alpha", status: "busy" },
              { id: "arm-beta", name: "arm-beta", status: "idle" },
            ],
          })),
        apiUrl: "http://coleo.test",
        headers: { "content-type": "application/json" },
      }),
    ).rejects.toThrow("Multiple active arms found. Pass a name or run from a TTY to choose one.");
  });

  it("shows inferred focus when no task or bug is recorded", () => {
    expect(
      getWatchFocusLine({
        arm: {
          id: "arm-alpha",
          name: "arm-alpha",
          status: "busy",
        },
        messages: [
          {
            info: { id: "msg-1", role: "assistant", time: "2026-03-30T14:25:00Z" },
            parts: [{ type: "text", text: "Investigating the stuck watcher activity signal." }],
          },
        ],
        showTools: true,
        showSystem: true,
      }),
    ).toContain("Focus inferred from recent activity");
  });

  it("prefers recorded task and bug labels when available", () => {
    expect(
      getWatchFocusLine({
        arm: {
          id: "arm-alpha",
          name: "arm-alpha",
          status: "busy",
          currentTaskSubject: "Investigate stale watch header",
          currentBugTitle: "Incorrect activity age",
        },
        messages: [],
        showTools: true,
        showSystem: true,
      }),
    ).toBe("Task Investigate stale watch header | Bug Incorrect activity age");
  });

  it("uses recent message timestamps to keep activity age fresh", () => {
    const originalNow = Date.now;
    Date.now = () => new Date("2026-03-30T14:30:00Z").getTime();

    try {
      expect(
        getWatchActivityAgeSeconds({
          arm: {
            id: "arm-alpha",
            name: "arm-alpha",
            status: "busy",
            runtime: {
              state: "active",
              reason: "running",
              secondsSinceOutput: 1200,
              secondsSinceActivity: 1200,
              secondsSinceHeartbeat: 5,
            },
          },
          messages: [
            {
              info: { id: "msg-1", role: "assistant", time: "2026-03-30T14:29:45Z" },
              parts: [{ type: "tool", tool: "coleo_get_full_briefing", state: "running" }],
            },
          ],
        }),
      ).toBe(15);
    } finally {
      Date.now = originalNow;
    }
  });

  it("clears the transient refresh notice after refresh settles", () => {
    expect(settleWatchRefreshNotice("Refreshing...", { succeeded: true })).toBeNull();
    expect(settleWatchRefreshNotice("Refreshing...", { succeeded: false })).toBeNull();
    expect(settleWatchRefreshNotice("Reloading messages with full text...", { succeeded: true })).toBeNull();
    expect(settleWatchRefreshNotice("Reloading messages with truncation...", { succeeded: false })).toBeNull();
    expect(settleWatchRefreshNotice("Message sent", { succeeded: true })).toBe("Message sent");
  });

  it("keeps the status indicator on the same line in narrow layouts", () => {
    const lines = buildAlignedArmLines(
      [
        {
          name: "🐙 very-long-arm-name-that-needs-shrinking",
          lifetime: "📡 12m",
          health: "📈 waiting_permission",
          task: "☑️ Debug the arm status layout wrapping bug",
          statusIndicator: "● Busy",
        },
      ],
      48,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("● Busy");
    expect(lines[0]?.includes("\n")).toBe(false);
  });
});
