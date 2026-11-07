import { expect, test } from "bun:test";
import { Brain } from "../brain";
import { detectBrainModelAccessIssue, serializeBrainModelAccessIssue } from "../model-access";
import type { BrainModelAccessIssue } from "../model-access";

interface HealthReporter {
  apiRequest: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>;
  reportPlanningGate: (error: unknown) => Promise<boolean>;
  reportBrainModelAccess: (issue: BrainModelAccessIssue | null) => Promise<void>;
  log: (message: string) => void;
}

test("repeated planning failures refresh health without notifying again", async () => {
  const brain = Object.create(Brain.prototype) as HealthReporter;
  const detail = "No readable .project/plan.md file was found";
  const writes: string[] = [];
  brain.apiRequest = async (_path, options) => {
    if (options?.method === "POST") { writes.push(options.body!); return { result: { success: true } }; }
    return { components: [{ component: "brain_planning_gate", healthy: false, error: JSON.stringify({ detail }) }] };
  };
  expect(await brain.reportPlanningGate(new Error(detail))).toBe(false);
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]!).components[0].healthy).toBe(false);
});

test("repeated model failures refresh health without duplicate alerts", async () => {
  const brain = Object.create(Brain.prototype) as HealthReporter;
  const issue = detectBrainModelAccessIssue(429, '{"error":{"message":"insufficient_quota"}}', "openai")!;
  const writes: string[] = [];
  brain.log = () => { throw new Error("Duplicate notification"); };
  brain.apiRequest = async (_path, options) => {
    if (options?.method === "POST") { writes.push(options.body!); return { result: { success: true } }; }
    return { components: [{ component: "brain_model_api", healthy: false, error: serializeBrainModelAccessIssue(issue) }] };
  };
  await brain.reportBrainModelAccess(issue);
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]!).components[0].healthy).toBe(false);
});
