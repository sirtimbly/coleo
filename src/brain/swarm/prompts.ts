import { readFileSync } from "fs";
import { join } from "path";
import { getPackageTemplatesDir } from "../template-manager";
import type { BrainTemplateManager } from "../template-manager";

interface PromptQuestion { instructions: string; criteria: Record<string, string> }
export interface SwarmPromptText {
  actions: Record<string, string>; routing: PromptQuestion; prefix: string;
  evidence: PromptQuestion; reason: PromptQuestion; priority: PromptQuestion; status: PromptQuestion; prompt: PromptQuestion;
}
const packaged = (name: string) => readFileSync(join(getPackageTemplatesDir(), name), "utf8");
export const DEFAULT_QUESTIONS = JSON.parse(packaged("jev-swarm-questions.jinja")) as SwarmPromptText;
export const DEFAULT_POLICY = packaged("jev-swarm-policy.jinja");

function validateShape(value: unknown, sample: unknown, path = "questions"): void {
  if (typeof sample === "string") {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be nonempty text`);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const expected = sample as Record<string, unknown>;
  const actual = value as Record<string, unknown>;
  if (Object.keys(actual).sort().join("|") !== Object.keys(expected).sort().join("|")) {
    throw new Error(`${path}: keep the existing keys; only edit their text`);
  }
  for (const key of Object.keys(expected)) validateShape(actual[key], expected[key], `${path}.${key}`);
}
export function parseSwarmQuestions(content: string): SwarmPromptText {
  const parsed: unknown = JSON.parse(content);
  validateShape(parsed, DEFAULT_QUESTIONS);
  return parsed as SwarmPromptText;
}
export function validateSwarmTemplate(name: string, content: string): void {
  if (name === "jev-swarm-questions.jinja") parseSwarmQuestions(content);
  if (name === "jev-swarm-policy.jinja" && !content.trim()) throw new Error("JEV policy must not be empty");
}
export async function loadSwarmPrompts(manager?: BrainTemplateManager): Promise<{ policy: string; questions: SwarmPromptText }> {
  if (!manager) return { policy: DEFAULT_POLICY, questions: DEFAULT_QUESTIONS };
  const [policy, questions] = await Promise.all([
    manager.renderTemplate("jev-swarm-policy.jinja"), manager.renderTemplate("jev-swarm-questions.jinja"),
  ]);
  validateSwarmTemplate("jev-swarm-policy.jinja", policy);
  return { policy, questions: parseSwarmQuestions(questions) };
}
export function fillPrompt(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(index|action|kind|id|description)\}/g, (match, key: string) => String(values[key] ?? match));
}
