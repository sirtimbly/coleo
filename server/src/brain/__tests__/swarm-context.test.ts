import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { swarmModelContext } from "../swarm/context";
import { detailQuestions, candidatesFor, SwarmEvaluator } from "../swarm/evaluator";
import type { SwarmSnapshot } from "../swarm/types";

function snapshot(): SwarmSnapshot {
  return { window: { since: "2026-09-22T01:00:00.000Z", until: "2026-09-22T01:05:00.000Z",
    pollIntervalMs: 30000, windowPolls: 10 }, entities: [
    { id: "task-a", kind: "task", version: "v1", state: { subject: "Keep this complete subject", description: "a".repeat(800) } },
    { id: "bug-a", kind: "bug", version: "v2", state: { title: "Bug title", description: "b".repeat(800) } },
  ], events: [{ id: "message:session-long:part-long:message-long", timestamp: "2026-09-22T01:04:00.000Z",
    actor: "Helena", target: "task-a", type: "assistant.message.completed", text: JSON.stringify({
      messageID: "message-long", partId: "part-long", session_id: "session-long", callID: "call-long",
      taskId: "task-a", bugId: "bug-a", text: "A useful finding",
      runningTools: [{ tool: "bash", callId: "call-long", startedAt: 123 }],
      nested: JSON.stringify({ sessionId: "nested-session", status: "failed" }),
    }) }], brainActions: [], evaluations: [], discoveries: [], coverage: { complete: true, notes: [] } };
}

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
describe("JEV compact model context", () => {
  it("removes transport identities but preserves domain IDs, outcomes, order and original audit evidence", () => {
    const source = snapshot(); source.brainActions = [{ ...source.events[0]!, actor: "brain" }];
    const before = JSON.stringify(source);
    const compact = swarmModelContext(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(JSON.stringify(compact)).not.toMatch(/message-long|part-long|session-long|call-long|nested-session/);
    expect(compact.events[0]).not.toHaveProperty("id");
    expect(compact.events[0]).toMatchObject({ actor: "Helena", target: "task-a", timestamp: source.events[0]!.timestamp });
    const payload = JSON.parse(compact.events[0]!.text);
    expect(payload).toMatchObject({ taskId: "task-a", bugId: "bug-a", text: "A useful finding" });
    expect(payload.runningTools).toEqual([{ tool: "bash", startedAt: 123 }]);
    expect(JSON.parse(payload.nested)).toEqual({ status: "failed" });
  });
  it("caps only task descriptions at 256 characters and labels the intentional excerpt", () => {
    const source = snapshot(); const context = swarmModelContext(source);
    expect(context.entities[0]!.state).toMatchObject({ subject: "Keep this complete subject",
      description: "a".repeat(256), descriptionTruncated: true });
    expect(context.entities[1]!.state.description).toHaveLength(800);
    source.entities[0]!.state.description = "short";
    expect(swarmModelContext(source).entities[0]!.state).not.toHaveProperty("descriptionTruncated");
    expect(context.coverage.complete).toBe(true);
  });
  it("keeps malformed historical text rather than silently erasing evidence", () => {
    const source = snapshot(); source.events[0]!.text = '{"text":"unfinished JSON';
    expect(swarmModelContext(source).events[0]!.text).toBe(source.events[0]!.text);
  });
  it("uses array evidence references without repeating long IDs in detail criteria", () => {
    const source = snapshot(); const questions = detailQuestions(candidatesFor(source).slice(0, 1), source);
    expect(questions.evidence_0!.criteria.e0).toBe("events[0]");
    expect(JSON.stringify(questions)).not.toContain(source.events[0]!.id);
  });
  it("sends the compact view in both stages and maps the chosen evidence back to its stable original ID", async () => {
    const requests: unknown[] = [];
    const mock = spyOn(TypeSafeClient.prototype, "systemOne").mockImplementation((async (request: Parameters<TypeSafeClient["systemOne"]>[0]) => {
      requests.push(request);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        const criteria = question.criteria as Record<string, unknown>;
        const choice = id === "action_0" ? "act" : id.startsWith("action_") ? "not_needed"
          : id.startsWith("evidence_") ? "e0" : id.startsWith("reason_") ? "new_finding" : "unchanged";
        return [id, { type: "choice" as const, choice, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])) }];
      }));
      return { model: "test", answers, usage: { input_tokens: 1, output_tokens: 1 } };
    }) as unknown as TypeSafeClient["systemOne"]);
    restore = () => mock.mockRestore();
    const source = snapshot(); const result = await new SwarmEvaluator("test-key").evaluate(source);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain("message-long");
    expect(JSON.stringify(requests)).not.toContain("a".repeat(257));
    expect(result.proposals[0]!.evidenceId).toBe(source.events[0]!.id);
    expect(result.proposals[0]!.evidenceText).toBe(source.events[0]!.text);
    expect(result.proposals[0]!.expectedVersion).toBe("v1");
  });
  it("shrinks and retries after a provider context rejection and audits the retry", async () => {
    const sizes: number[] = [];
    const mock = spyOn(TypeSafeClient.prototype, "systemOne").mockImplementation((async (request: Parameters<TypeSafeClient["systemOne"]>[0]) => {
      sizes.push(JSON.stringify(request).length);
      if (sizes.length === 1) throw Object.assign(new Error("Input tokens exceed maximum context length"), { status: 422 });
      return { model: "test", answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, {
        type: "choice", choice: "not_needed", confidence: 1,
        probabilities: Object.fromEntries(Object.keys(q.criteria as object).map(key => [key, key === "not_needed" ? 1 : 0])),
      }])), usage: { input_tokens: 1, output_tokens: 1 } };
    }) as unknown as TypeSafeClient["systemOne"]);
    restore = () => mock.mockRestore();
    const source = snapshot();
    source.events = Array.from({ length: 40 }, (_, i) => ({ ...source.events[0]!, id: `id-${i}`,
      timestamp: new Date(1700000000000 + i).toISOString(), text: "event content ".repeat(130) }));
    const result = await new SwarmEvaluator("test-key").evaluate(source);
    expect(sizes).toHaveLength(2);
    expect(sizes[1]!).toBeLessThan(sizes[0]!);
    expect(result.contextReductions![0]!.retries).toBe(1);
    expect(result.contextReductions![0]!.eventsOmitted).toBeGreaterThan(0);
    expect(source.events).toHaveLength(40);
  });
});
