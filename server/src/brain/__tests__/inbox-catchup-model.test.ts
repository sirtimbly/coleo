import { expect, test } from "bun:test";
import { z } from "zod";
import { createCatchupModel } from "../inbox-catchup-model";
import { mapCatchupWork } from "../inbox-catchup-workers";
import { batchJevCatchupQuestions } from "../inbox-catchup-questions";

const config = { provider: "openai", model: "reasoning-model", apiKey: "test-private-key", baseUrl: "https://provider.test/v1" };
test("uses the configured Brain model and enforces structured responses", async () => {
  let payload: Record<string, unknown> = {};
  const request: typeof fetch = Object.assign(async (_input: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-private-key");
    payload = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] });
  }, { preconnect: fetch.preconnect });
  expect(await createCatchupModel({ config, request })("Review", {}, z.object({ ok: z.boolean() }).strict())).toEqual({ ok: true });
  expect(payload).toMatchObject({ model: "reasoning-model", max_completion_tokens: 8192,
    response_format: { type: "json_schema", json_schema: { strict: true } } });
});
test("rejects truncated output without exposing provider response bodies", async () => {
  const request: typeof fetch = Object.assign(async () => Response.json({ choices: [{ finish_reason: "length", message: { content: '{}' } }] }), { preconnect: fetch.preconnect });
  await expect(createCatchupModel({ config, request })("Review", {})).rejects.toThrow("incomplete");
  const rejected: typeof fetch = Object.assign(async () => new Response("secret-provider-body", { status: 401 }), { preconnect: fetch.preconnect });
  await expect(createCatchupModel({ config, request: rejected })("Review", {})).rejects.toThrow("HTTP 401");
});
test("retries brief provider throttling", async () => {
  let requests = 0;
  const request: typeof fetch = Object.assign(async () => ++requests === 1
    ? new Response("Throttled", { status: 429, headers: { "Retry-After": "0" } })
    : Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }), { preconnect: fetch.preconnect });
  expect(await createCatchupModel({ config, request })("Review", {})).toEqual({ ok: true });
  expect(requests).toBe(2);
});
test("JEV batching preserves questions and rejects oversized evidence", () => {
  const questions = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [String(index), { type: "noul" as const, instructions: "Is action needed?" }]));
  expect(batchJevCatchupQuestions({}, questions).flatMap(batch => Object.keys(batch))).toHaveLength(100);
  expect(() => batchJevCatchupQuestions({ body: "x".repeat(28_000) }, questions)).toThrow("per-question budget");
});
test("a failed worker drains active work before returning", async () => {
  const started: number[] = []; let drained = false;
  await expect(mapCatchupWork([0, 1, 2, 3], 2, async value => {
    started.push(value);
    if (value === 0) throw new Error("Provider failed");
    await new Promise(resolve => setTimeout(resolve, 5)); drained = true;
  })).rejects.toThrow("Provider failed");
  expect(started).toEqual([0, 1]); expect(drained).toBe(true);
});
