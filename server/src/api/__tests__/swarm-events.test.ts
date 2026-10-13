import { describe, expect, it } from "bun:test";
import { projectSwarmEvents } from "../swarm-events";
import type { EventData } from "../../nats/jetstream-types";

function event(type: string, data: Record<string, unknown>, sequence: number, armId = "a"): EventData {
  return { type, data, sequence, armId, sessionId: "s", timestamp: new Date(1700000000000 + sequence).toISOString() };
}
const text = (id: string, value: string, completed: boolean) => ({ part: {
  id, messageID: "m", type: "text", text: value, time: { start: 1, ...(completed ? { end: 2 } : {}) },
} });
const tool = (status: string, extra = {}) => ({ part: { id: "p", messageID: "m", type: "tool", tool: "bash",
  callID: "call", state: { status, time: { start: 1, end: 2 }, ...extra } } });

describe("completed swarm activity projection", () => {
  it("uses final text once, drops unfinished prose and reasoning, and keeps progress", () => {
    const result = projectSwarmEvents([
      event("message.part.delta", { delta: "Test " }, 1),
      event("message.part.updated", text("p", "Test ", false), 2),
      event("message.part.updated", text("p", "Test passed", true), 3),
      event("message.part.updated", text("p", "Test passed", true), 4),
      event("message.part.updated", text("unfinished", "Maybe delete everything", false), 5),
      event("message.part.updated", { part: { type: "reasoning", text: "private reasoning" } }, 6),
    ]);
    expect(result.notes).toEqual([]);
    expect(result.events.filter(e => e.type === "assistant.message.completed")).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("Test passed");
    expect(JSON.stringify(result)).not.toContain("Maybe delete");
    expect(JSON.stringify(result)).not.toContain("private reasoning");
    expect(result.events.find(e => e.type === "arm.progress")?.text).toContain("lastProgressAt");
  });
  it("accepts explicit parent completion and isolates matching IDs across arms and sessions", () => {
    const a = event("message.part.updated", text("p", "Arm A done", false), 1);
    const b = event("message.part.updated", text("p", "Arm B incomplete", false), 2, "b");
    const other = { ...a, sessionId: "other", data: text("p", "Other session incomplete", false) };
    const result = projectSwarmEvents([a, b, other,
      event("message.updated", { info: { id: "m", time: { completed: 3 } } }, 3)]);
    expect(result.events.filter(e => e.type === "assistant.message.completed")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("incomplete");
  });
  it("consolidates tool updates, keeps failures, and ignores delayed running duplicates", () => {
    const result = projectSwarmEvents([
      event("message.part.updated", tool("pending"), 1),
      event("message.part.updated", tool("running", { input: { command: "bun test" } }), 2),
      event("message.part.updated", tool("error", { error: "Tests failed: expected 200, received 500" }), 3),
      event("message.part.updated", tool("error", { error: "Tests failed: expected 200, received 500" }), 4),
      event("message.part.updated", tool("running"), 5),
    ]);
    const outcomes = result.events.filter(e => e.type === "tool.completed");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.text).toContain("received 500");
    expect(JSON.parse(result.events.find(e => e.type === "arm.progress")!.text).runningTools).toEqual([]);
  });
  it("retains running tool identity and start time without unfinished payloads", () => {
    const result = projectSwarmEvents([event("message.part.updated", tool("running", {
      input: { command: "secret unfinished payload" },
    }), 1), event("session.status", { status: { type: "busy" } }, 2)]);
    expect(result.events).toHaveLength(1);
    const progress = JSON.parse(result.events[0]!.text);
    expect(progress.sessionStatus).toBe("busy");
    expect(progress.runningTools[0]).toMatchObject({ tool: "bash", callId: "call", startedAt: 1 });
    expect(JSON.stringify(result)).not.toContain("secret unfinished");
  });
  it("preserves immediate errors, help requests, brain actions and redacts structured credentials", () => {
    const result = projectSwarmEvents([
      event("session.error", { error: "connection failed", apiKey: "secret-value" }, 1),
      event("help.requested", { question: "Which branch?" }, 2),
      event("prompt_sent", { actor: "brain", message: "Already prompted", password: "secret-value" }, 3),
    ]);
    expect(result.events.map(e => e.type)).toEqual(["session.error", "help.requested", "prompt_sent"]);
    expect(result.events[2]!.actor).toBe("brain");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
  it("applies the evidence limit after dropping thousands of deltas", () => {
    const raw = [event("assistant.message", { message: "Important completed finding" }, 1)];
    for (let i = 2; i < 3000; i++) raw.push(event("message.part.delta", { delta: "noise" }, i));
    const result = projectSwarmEvents(raw, 2);
    expect(result.notes).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.text).toContain("Important completed finding");
  });
  it("marks lost completed evidence incomplete, but intentional tool excerpts are explicit", () => {
    const result = projectSwarmEvents([
      event("message.part.updated", text("p", "x".repeat(9000), true), 1),
      event("message.part.updated", tool("completed", { output: "y".repeat(9000) }), 2),
    ]);
    expect(result.notes).toHaveLength(1);
    const outcome = JSON.parse(result.events.find(e => e.type === "tool.completed")!.text);
    expect(outcome.resultExcerpt).toHaveLength(800);
    expect(outcome.payloadElided).toBe(true);
    expect(projectSwarmEvents([
      event("assistant.message", { message: "first" }, 1),
      event("assistant.message", { message: "second" }, 2),
    ], 1).notes.join()).toContain("exceeds 1");
  });
});
