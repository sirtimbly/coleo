import { expect, test } from "bun:test";
import { catchupOverview, planCatalogueCatchup, reduceCatalogueThread } from "../inbox-catchup-catalogue";
import type { CatalogueDecision } from "../inbox-catchup-catalogue";
import type { CatchupSource } from "../../workbench/inbox-catchup";
import type { JevCatchupRequest } from "../inbox-catchup-questions";

const thread = { title: "Release task 42 file claim", kind: "stale_claim", taskIds: ["task-42"], bugIds: [], armIds: [], files: ["src/app.ts"],
  includes: "Task 42 on src/app.ts only", excludes: "Other tasks and files",
  resolves: "Explicit release of task 42 src/app.ts claim", reopens: "Claim reacquired and task 42 blocked again" };
const source = (id: string, minute = 1, unread = true): CatchupSource => ({ id, body: "Please release task 42 src/app.ts claim.",
  subject: "Blocked", from: "arm", timestamp: `2026-11-07T10:${String(minute).padStart(2, "0")}:00.000Z`, unread, mailbox: "inbox" });
function response(request: JevCatchupRequest, effect = "open", uncovered = 0, probability = .99) {
  return { model: "jev-test", usage: { input_tokens: 100, output_tokens: 10 },
    answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, id === "uncovered" || id === "operator_needed" ? { type: "noul", noul: uncovered }
      : { type: "choice", choice: effect, confidence: .9, probabilities: Object.fromEntries(
        ["unrelated", "open", "resolved", "reopened", "informational", "uncertain"].map(key => [key, key === effect ? probability : (1 - probability) / 5])) }])) };
}
function decision(sourceId: string, effect: CatalogueDecision["effect"]): CatalogueDecision {
  return { sourceId, threadId: "thread-0", effect, selected: effect, probability: .99, probabilities: {} };
}

test("overview preserves every character rather than truncating large mailboxes", () => {
  const sources = Array.from({ length: 52 }, (_, index) => ({ ...source(`source-${index}`), body: "long message ".repeat(1000) }));
  const overview = catchupOverview(sources);
  for (const source of sources) expect(overview.filter(row => row.id === source.id).map(row => row.excerpt).join("")).toBe(source.body);
  expect(overview.every(row => !row.truncated)).toBe(true);
});

test("overview runs once; JEV sees full message; full originals reach final LLM", async () => {
  const calls: Array<{ task: string; input: unknown }> = [];
  const full = { ...source("a"), body: "Important original evidence. ".repeat(100) };
  const result = await planCatalogueCatchup([full], async (task, input) => {
    calls.push({ task, input });
    return calls.length === 1 ? { threads: [thread] } : { context: "Task 42 remains blocked.", action: "Release task 42's file claim." };
  }, { query: async request => {
    expect((request.state.message as { body: string }).body).toBe(full.body);
    return response(request);
  } });
  expect(calls).toHaveLength(2);
  expect((calls[1]!.input as { messages: Array<{ body: string }> }).messages[0]!.body).toBe(full.body);
  expect(result.plan.actions[0]!.sourceIds).toEqual(["a"]);
});

test("one full message can close multiple proposed threads without final synthesis", async () => {
  const result = await planCatalogueCatchup([source("a")], async () => ({ threads: [thread, { ...thread, title: "Second distinct request" }] }),
    { query: async request => response(request, "resolved") });
  expect(result.plan.resolvedTopics).toBe(2);
  expect(result.metrics.brainCalls).toBe(1);
  expect(result.plan.actions).toHaveLength(0);
});

test("unmatched messages stay available for review", async () => {
  const result = await planCatalogueCatchup([source("a")], async () => ({ threads: [thread] }),
    { query: async request => response(request, "unrelated", .99) });
  expect(result.plan.retainedSources?.map(source => source.sourceId)).toEqual(["a"]);
  expect(result.plan.archiveSourceIds).toEqual([]);
  expect(result.metrics.unmatchedUnread).toBe(1);
  expect(result.metrics.uncoveredUnread).toBe(1);
});

test("uncovered issue keeps a multi-topic original while its known action is summarized", async () => {
  let calls = 0;
  const result = await planCatalogueCatchup([source("a")], async () => ++calls === 1 ? { threads: [thread] }
    : { context: "Blocked", action: "Release claim" }, { query: async request => response(request, "open", .99) });
  expect(result.plan.actions).toHaveLength(1);
  expect(result.plan.retainedSources?.map(source => source.sourceId)).toEqual(["a"]);
  expect(result.metrics.unmatchedUnread).toBe(0);
});

test("low-probability closure is kept open", async () => {
  let calls = 0;
  const result = await planCatalogueCatchup([source("a")], async () => ++calls === 1 ? { threads: [thread] }
    : { context: "Needs review", action: "Check the claim" }, { query: async request => response(request, "resolved", 0, .75) });
  expect(result.plan.resolvedTopics).toBe(0);
  expect(result.decisions[0]!.effect).toBe("uncertain");
});

test("malformed or omitted JEV answers fail safely", async () => {
  await expect(planCatalogueCatchup([source("a")], async () => ({ threads: [thread] }), { query: async request => {
    const answer = response(request);
    delete answer.answers.uncovered;
    return answer;
  } })).rejects.toThrow("omitted or added");
});

test("chronology is independent of completion order and progress does not clear blockers", () => {
  const sources = [source("a", 1), source("b", 2), source("c", 3)];
  expect(reduceCatalogueThread([decision("b", "resolved"), decision("a", "open"), decision("c", "informational")], sources).status).toBe("resolved");
  expect(reduceCatalogueThread([decision("a", "open"), decision("b", "informational")], sources).status).toBe("open");
  expect(reduceCatalogueThread([decision("a", "resolved"), decision("c", "reopened")], sources).status).toBe("open");
});

test("equal-timestamp conflicts and possible repeated requests remain reviewable", () => {
  expect(reduceCatalogueThread([decision("a", "resolved"), decision("b", "open")], [source("a"), source("b")])).toMatchObject({ status: "open", review: true });
  expect(reduceCatalogueThread([decision("a", "resolved"), decision("b", "open")], [source("a", 1), source("b", 2)])).toMatchObject({ status: "open", review: true });
});

test("per-message concurrency stays bounded", async () => {
  let active = 0; let maximum = 0; let brainCalls = 0;
  await planCatalogueCatchup(Array.from({ length: 6 }, (_, index) => source(`s-${index}`)), async () => ++brainCalls === 1 ? { threads: [thread] }
    : { context: "Blocked", action: "Release claim" }, { concurrency: 2, query: async request => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return response(request);
    } });
  expect(maximum).toBe(2);
});

test("long messages reach JEV in full through numbered parts and remain unarchived", async () => {
  const body = "中🙂\n".repeat(10_000);
  const seen: string[] = [];
  const result = await planCatalogueCatchup([{ ...source("a"), body }], async task => task.startsWith("Propose")
    ? { threads: [] } : { matches: [] }, { query: async request => {
      seen.push((request.state.message as { body: string }).body);
      return response(request, "unrelated");
    } });
  expect(seen.join("")).toBe(body);
  expect(result.plan.archiveSourceIds).toEqual([]);
  expect(result.plan.retainedSources).toHaveLength(1);
});

test("oversized synthesis packets batch all originals into evidence notes", async () => {
  let calls = 0;
  const sources = Array.from({ length: 8 }, (_, index) => ({ ...source(`a-${index}`), body: "z".repeat(15_000) }));
  const result = await planCatalogueCatchup(sources, async (task, input) => {
    calls++;
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(100_000);
    if (task.startsWith("Propose")) return { threads: [thread] };
    if (task.startsWith("Reconcile")) return { matches: [{ leftId: "thread-0", rightId: "thread-1" }] };
    if (task.startsWith("Extract evidence")) return { evidence: "The claim remains blocked." };
    return { context: "Blocked", action: "Release the claim" };
  }, { query: async request => response(request) });
  expect(calls).toBeGreaterThan(3);
  expect(result.plan.actions[0]!.sourceIds).toHaveLength(8);
  expect(result.plan.actions[0]!.action).toBe("Release the claim");
});

test("1,000 messages are discovered in bounded batches with no mailbox cap", async () => {
  const sources = Array.from({ length: 1000 }, (_, index) => source(`s-${index}`));
  const seen: string[] = [];
  const result = await planCatalogueCatchup(sources, async (_task, input) => {
    const batch = input as { overview: Array<{ id: string }> };
    expect(batch.overview.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(100_000);
    seen.push(...batch.overview.map(row => row.id));
    return { threads: [] };
  }, { query: async request => response(request, "unrelated") });
  expect(new Set(seen).size).toBe(1000);
  expect(result.metrics.discoveryBatches).toBe(16);
  expect(result.plan.archiveSourceIds).toHaveLength(1000);
});

test("health notices bypass both models and become exactly one action", async () => {
  const sources = Array.from({ length: 200 }, (_, index) => ({ ...source(`health-${index}`),
    subject: "[coleo] Infrastructure health issues detected" }));
  const result = await planCatalogueCatchup(sources, async () => { throw new Error("Brain must not be called"); },
    { query: async () => { throw new Error("JEV must not be called"); } });
  expect(result.plan.actions).toHaveLength(1);
  expect(result.plan.actions[0]!.sourceIds).toHaveLength(200);
  expect(result.plan.archiveSourceIds).toHaveLength(200);
  expect(result.metrics.brainCalls + result.metrics.jevRequests).toBe(0);
});

test("cross-batch duplicate threads reconcile a later resolution without losing evidence", async () => {
  const sources = [source("request", 1), source("answer", 2, false)];
  let proposals = 0;
  const result = await planCatalogueCatchup(sources, async task => task.startsWith("Propose") ? { threads: [{ ...thread, title: `Claim release ${++proposals}` }] }
    : { matches: [{ leftId: "thread-0", rightId: "thread-1" }] }, { batchMessages: 1,
      query: async request => response(request, (request.state.message as { id: string }).id === "answer" ? "resolved" : "open") });
  expect(result.plan.actions).toEqual([]);
  expect(result.plan.closedTopics).toHaveLength(1);
  expect(result.plan.closedTopics![0]!.sourceIds).toEqual(["request", "answer"]);
  expect(result.plan.archiveSourceIds).toEqual(["request"]);
});

test("more than 48 independent threads use bounded JEV scope pages without dropping threads", async () => {
  let discovery = 0;
  const result = await planCatalogueCatchup([source("a"), source("b")], async (task, input) => {
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(100_000);
    if (task.startsWith("Reconcile")) return { matches: [] };
    const batch = discovery++;
    return { threads: Array.from({ length: 30 }, (_, index) => ({ ...thread,
      title: `Decision ${batch * 30 + index}`, kind: "decision", includes: "Independent requirement ".repeat(8) })) };
  }, { batchMessages: 1, query: async request => {
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(60_000);
    return response(request, "resolved");
  } });
  expect(result.threads).toHaveLength(60);
  expect(result.plan.resolvedTopics).toBe(60);
});

test("health notice content is absent from mixed-mailbox model inputs", async () => {
  const marker = "health-only-private-marker";
  const result = await planCatalogueCatchup([source("ordinary"), { ...source("health"),
    subject: "[coleo] Infrastructure health issues detected", body: marker }], async (_task, input) => {
    expect(JSON.stringify(input)).not.toContain(marker);
    return { threads: [] };
  }, { query: async request => {
    expect(JSON.stringify(request)).not.toContain(marker);
    return response(request, "unrelated");
  } });
  expect(result.plan.actions).toHaveLength(1);
  expect(result.plan.archiveSourceIds).toHaveLength(2);
});

test("read context can resolve unread reports and input messages remain unchanged", async () => {
  const sources = [source("a", 1), { ...source("b", 2, false), body: "The claim was released." }];
  const before = JSON.stringify(sources);
  const result = await planCatalogueCatchup(sources, async () => ({ threads: [thread] }), { query: async request =>
    response(request, (request.state.message as { id: string }).id === "b" ? "resolved" : "open") });
  expect(result.plan.resolvedTopics).toBe(1);
  expect(result.plan.closedTopics![0]!.sourceIds).toEqual(["a", "b"]);
  expect(JSON.stringify(sources)).toBe(before);
});
