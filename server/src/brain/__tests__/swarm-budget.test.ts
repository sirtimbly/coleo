import { describe, expect, it } from "bun:test";
import { fitSwarmRequest, isContextSizeError } from "../swarm/budget";
import { swarmModelContext } from "../swarm/context";
import { candidatesFor, detailQuestions, routingQuestions, sharedRubrics } from "../swarm/evaluator";
import type { SwarmSnapshot } from "../swarm/types";

function snapshot(): SwarmSnapshot {
  return { window: { since: "2026-09-22T01:00:00Z", until: "2026-09-22T01:05:00Z", pollIntervalMs: 30000, windowPolls: 10 },
    entities: [{ id: "arm", kind: "arm", version: "2026-09-22T01:00:00Z", state: { status: "idle" } }],
    events: Array.from({ length: 40 }, (_, i) => ({ id: `original-${i}`, timestamp: new Date(1700000000000 + i * 1000).toISOString(),
      actor: "arm", target: "arm", type: "message", text: `${i}: ${"event ".repeat(100)}` })),
    discoveries: ["new", "old"].map((id, i) => ({ id, title: id, taskId: null, details: "detail ".repeat(200),
      updatedAt: new Date(1700000000000 - i * 1000).toISOString() })),
    brainActions: [{ id: "protected", actor: "brain", target: "arm", timestamp: "2026-09-22T01:00:00Z", type: "prompt_sent", text: "Already prompted" }],
    evaluations: [], coverage: { complete: true, notes: [] } };
}
const build = (s: SwarmSnapshot) => ({ state: { ...swarmModelContext(s), evaluationPolicy: "Preserve safeguards" },
  questions: { check: { type: "choice" as const, instructions: "Check state", criteria: { yes: null, no: null } } } });
describe("iterative context fitting", () => {
  it("removes oldest activity, retains recent evidence and prior actions, and leaves original audit data intact", () => {
    const source = snapshot(), original = JSON.stringify(source);
    const fit = fitSwarmRequest(source, build, { totalChars: 7000, stateAndQuestionBytes: 6500 });
    expect(fit.reduction.finalChars).toBeLessThanOrEqual(7000);
    expect(fit.reduction.eventsOmitted).toBeGreaterThan(0);
    expect(fit.snapshot.events.at(-1)!.id).toBe("original-39");
    expect(fit.snapshot.events.map(e => e.id)).toEqual(source.events.slice(-fit.snapshot.events.length).map(e => e.id));
    expect(fit.snapshot.brainActions).toEqual(source.brainActions);
    expect(JSON.stringify(source)).toBe(original);
    expect(fit.state.contextSelection).toBeDefined();
  });
  it("shortens older discovery details first but keeps every title for duplicate detection", () => {
    const source = snapshot(); source.events = source.events.slice(-1);
    const all = fitSwarmRequest(source, build);
    const fit = fitSwarmRequest(source, build, { totalChars: all.reduction.finalChars - 500, stateAndQuestionBytes: 90000 });
    expect(fit.snapshot.discoveries[0]!.details).toHaveLength(1400);
    expect(fit.snapshot.discoveries[1]!.details).toHaveLength(256);
    expect(fit.snapshot.discoveries.map(d => d.title)).toEqual(["new", "old"]);
  });
  it("handles the 255-option evidence cap after trimming, with indices pointing to retained originals", () => {
    const source = snapshot(); source.events = Array.from({ length: 300 }, (_, i) => ({ ...source.events[0]!, id: `id-${i}`,
      timestamp: new Date(1700000000000 + i).toISOString(), text: "ok" }));
    const candidates = candidatesFor(source).slice(0, 1);
    const fit = fitSwarmRequest(source, s => ({ state: { ...swarmModelContext(s) }, questions: detailQuestions(candidates, s) }),
      { totalChars: 1000000, stateAndQuestionBytes: 1000000 });
    expect(Object.keys(fit.questions.evidence_0!.criteria).length).toBeLessThanOrEqual(255);
    expect(fit.questions.evidence_0!.criteria.e0).toBe("events[0]");
    expect(fit.snapshot.events.at(-1)!.id).toBe("id-299");
  });
  it("fails explicitly when protected state alone cannot fit rather than looping or discarding receipts", () => {
    const source = snapshot(); source.events = []; source.discoveries = [];
    source.brainActions[0]!.text = "protected action ".repeat(1000);
    expect(() => fitSwarmRequest(source, build, { totalChars: 1000, stateAndQuestionBytes: 1000 })).toThrow("protected state");
  });
  it("retries only context-size rejections, not auth, rate limits or unrelated validation failures", () => {
    expect(isContextSizeError({ status: 422, message: "Input token count exceeds maximum context length" })).toBe(true);
    expect(isContextSizeError({ status: 413, message: "Request too large" })).toBe(true);
    for (const error of [{ status: 401, message: "bad key" }, { status: 429, message: "token rate limit" },
      { status: 422, message: "Invalid criteria" }, new Error("Network failure")]) expect(isContextSizeError(error)).toBe(false);
  });
  it("shares full rubric definitions once while every question retains its options and explicit candidate reference", () => {
    const candidates = candidatesFor(snapshot()), rubrics = sharedRubrics();
    const questions = routingQuestions(candidates);
    expect(questions.action_0!.instructions).toContain("candidates[0]");
    expect(questions.action_1!.instructions).toContain("candidates[1]");
    expect(questions.action_0!.criteria.act).toBeNull();
    expect(rubrics.routing.criteria.act).toContain("Concrete new evidence");
    expect(rubrics.actions.create_bug).toContain("malfunction");
  });
});
