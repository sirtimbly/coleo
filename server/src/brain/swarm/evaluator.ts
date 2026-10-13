import { TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import { proposalSchema } from "./types";
import { swarmModelContext } from "./context";
import { DEFAULT_CONTEXT_BUDGET, fitSwarmRequest, isContextSizeError } from "./budget";
import type { BudgetQuestions, FittedRequest } from "./budget";
import type { SwarmAction, SwarmCandidate, SwarmEvaluation, SwarmProposal, SwarmSnapshot } from "./types";

import { DEFAULT_QUESTIONS, loadSwarmPrompts } from "./prompts";
import type { SwarmPromptText } from "./prompts";
import type { BrainTemplateManager } from "../template-manager";
import type { BrainResponsibilitySettings } from "../responsibilities";

type Questions = BudgetQuestions;
const choiceKeys = (criteria: Record<string, string>): Record<string, null> => Object.fromEntries(Object.keys(criteria).map(key => [key, null]));
export function sharedRubrics(text: SwarmPromptText = DEFAULT_QUESTIONS): SwarmPromptText { return text; }
const answerSchema = z.object({ answers: z.record(z.string(), z.object({
  type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), z.number().min(0).max(1)),
})) });
export function validateAnswers(raw: unknown, questions: Questions): z.infer<typeof answerSchema>["answers"] {
  const { answers } = answerSchema.parse(raw);
  for (const [key, question] of Object.entries(questions)) {
    const answer = answers[key];
    if (!answer || !Object.hasOwn(question.criteria, answer.choice)) throw new Error(`Invalid swarm answer ${key}`);
    if (Object.keys(answer.probabilities).sort().join("|") !== Object.keys(question.criteria).sort().join("|")
      || Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > .02) {
      throw new Error(`Invalid swarm probabilities ${key}`);
    }
  }
  return answers;
}

export function candidatesFor(snapshot: SwarmSnapshot): SwarmCandidate[] {
  return snapshot.entities.flatMap((entity) => {
    let actions: SwarmAction[];
    if (entity.kind === "arm") {
      actions = ["log_discovery", "create_bug", "notify_human", "restart_dev_server", "preserve_git_work"];
      if (!["stopped", "error", "paused"].includes(String(entity.state.status))) actions.push("prompt_arm", "stop_arm");
    } else actions = entity.kind === "task" ? ["update_task", "comment_task"] : ["update_bug"];
    return actions.map((action) => ({ action, entity }));
  });
}

export function routingQuestions(candidates: SwarmCandidate[], text: SwarmPromptText = DEFAULT_QUESTIONS): Questions {
  return Object.fromEntries(candidates.map((candidate, index) => [`action_${index}`, {
    type: "choice" as const,
    instructions: `Apply evaluationPolicy and rubrics.routing to candidates[${index}]. Use rubrics.actions for the action definition.`,
    criteria: choiceKeys(text.routing.criteria),
  }]));
}

export function detailQuestions(candidates: SwarmCandidate[], snapshot: SwarmSnapshot, text: SwarmPromptText = DEFAULT_QUESTIONS): Questions {
  const questions: Questions = {};
  const evidence = Object.fromEntries(snapshot.events.map((_, index) => [`e${index}`, `events[${index}]`]));
  for (const [index, candidate] of candidates.entries()) {
    const prefix = `Apply evaluationPolicy. For selected[${index}], `;
    const add = (name: "evidence" | "reason" | "priority" | "status" | "prompt", criteria = text[name].criteria) => {
      questions[`${name}_${index}`] = { type: "choice", instructions: prefix + `use rubrics.${name}.`,
        criteria: name === "evidence" ? criteria : choiceKeys(criteria) };
    };
    add("evidence", { ...evidence, ...text.evidence.criteria });
    add("reason");
    if (["update_task", "update_bug", "create_bug"].includes(candidate.action)) {
      const criteria = { ...text.priority.criteria };
      delete criteria[candidate.action === "update_task" ? "medium" : "normal"];
      add("priority", criteria);
    }
    if (candidate.action === "update_task") add("status");
    if (candidate.action === "prompt_arm") add("prompt");
  }
  return questions;
}

export class SwarmEvaluator {
  private client: TypeSafeClient;
  constructor(apiKey: string, private model = "jev-latest", private templates?: BrainTemplateManager,
    private actionModes?: BrainResponsibilitySettings["swarmActionModes"]) {
    this.client = new TypeSafeClient({ apiKey, baseURL: "https://api.typesafe.ai", timeout: 12000, retry: { maxRetries: 0 }, logLevel: "off" });
  }
  private async query(snapshot: SwarmSnapshot,
    build: (snapshot: SwarmSnapshot) => { state: Record<string, unknown>; questions: Questions }): Promise<{
      answers: z.infer<typeof answerSchema>["answers"]; fitted: FittedRequest;
    }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = .7 ** attempt;
      const fitted = fitSwarmRequest(snapshot, build, {
        totalChars: Math.floor(DEFAULT_CONTEXT_BUDGET.totalChars * scale),
        stateAndQuestionBytes: Math.floor(DEFAULT_CONTEXT_BUDGET.stateAndQuestionBytes * scale),
      }, attempt);
      try {
        const response = await this.client.systemOne({ model: this.model, state: fitted.state as Parameters<TypeSafeClient["systemOne"]>[0]["state"], questions: fitted.questions });
        return { answers: validateAnswers(response, fitted.questions), fitted };
      } catch (error) {
        if (!isContextSizeError(error) || attempt === 3) throw error;
      }
    }
    throw new Error("Swarm context fitting exhausted");
  }
  async evaluate(snapshot: SwarmSnapshot): Promise<SwarmEvaluation> {
    const started = performance.now();
    const candidates = candidatesFor(snapshot).filter(candidate => this.actionModes?.[candidate.action] !== "off");
    if (!snapshot.events.length || !candidates.length) return { proposals: [], model: this.model, elapsedMs: 0 };
    const prompts = await loadSwarmPrompts(this.templates);
    const rubrics = sharedRubrics(prompts.questions);
    const wireCandidate = (candidate: SwarmCandidate) => ({ action: candidate.action, targetId: candidate.entity.id, targetType: candidate.entity.kind });
    const routingResult = await this.query(snapshot, current => ({
      state: { evaluationPolicy: prompts.policy, ...swarmModelContext(current), rubrics, candidates: candidates.map(wireCandidate) },
      questions: routingQuestions(candidates, prompts.questions),
    }));
    const routing = routingResult.answers;
    const contextReductions = [routingResult.fitted.reduction];
    // Keep the highest-confidence concrete candidates; independent questions cannot coordinate slots.
    const selected = candidates.map((candidate, index) => ({ ...candidate, answer: routing[`action_${index}`]! }))
      .filter(({ answer }) => answer.choice === "act")
      .sort((a, b) => b.answer.probabilities.act! - a.answer.probabilities.act!).slice(0, 8);
    const proposals: SwarmProposal[] = [];
    if (selected.length) {
      const detailResult = await this.query(routingResult.fitted.snapshot, current => ({
        state: { evaluationPolicy: prompts.policy, ...swarmModelContext(current), rubrics, selected: selected.map(wireCandidate) },
        questions: detailQuestions(selected, current, prompts.questions),
      }));
      const details = detailResult.answers;
      contextReductions.push(detailResult.fitted.reduction);
      for (const [index, candidate] of selected.entries()) {
        const evidenceAnswer = details[`evidence_${index}`]!;
        if (evidenceAnswer.choice === "none") continue;
        const event = detailResult.fitted.snapshot.events[Number(evidenceAnswer.choice.slice(1))];
        if (!event) throw new Error("Missing evidence event");
        const detailAnswers = Object.entries(details).filter(([key]) => key.endsWith(`_${index}`)).map(([, value]) => value);
        proposals.push(proposalSchema.parse({ action: candidate.action, targetId: candidate.entity.id, targetType: candidate.entity.kind,
          expectedVersion: candidate.entity.version, reason: details[`reason_${index}`]!.choice,
          evidenceId: event.id, evidenceAt: event.timestamp, evidenceText: event.text,
          probability: Math.min(candidate.answer.probabilities.act!, ...detailAnswers.map((answer) => answer.probabilities[answer.choice]!)),
          parameters: { priority: details[`priority_${index}`]?.choice || "unchanged", status: details[`status_${index}`]?.choice || "unchanged",
            prompt: details[`prompt_${index}`]?.choice || "investigate" } }));
      }
    }
    return { proposals, model: this.model, elapsedMs: performance.now() - started, contextReductions,
      decisions: candidates.map((candidate, index) => {
        const answer = routing[`action_${index}`]!;
        return { action: candidate.action, targetId: candidate.entity.id, outcome: answer.choice, probability: answer.probabilities[answer.choice]! };
      }) };
  }
}
