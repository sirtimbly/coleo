import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brain } from '../brain';
import { updateConfig } from '../../config';
import { BrainTemplateManager } from '../template-manager';
import { candidatesFor, routingQuestions, SwarmEvaluator } from '../swarm/evaluator';
import { loadSwarmPrompts, parseSwarmQuestions } from '../swarm/prompts';
import type { ArmOutputDecision } from '../arm-output-processor';
import type { Arm } from '../../types';
import type { SwarmSnapshot } from '../swarm/types';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'brain-responsibilities-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('reads edited JEV instructions and policy for the next evaluation; rejects altered choice keys', async () => {
  const templates = new BrainTemplateManager(dir, () => {});
  await templates.ensureTemplatesExist();
  const original = await loadSwarmPrompts(templates);
  const edited = structuredClone(original.questions);
  edited.routing.instructions = 'Custom question about {action} for {id}: {description}';
  edited.routing.criteria.wait = 'Wait longer before another intervention.';
  await writeFile(join(dir, 'src/brain/templates/jev-swarm-questions.jinja'), JSON.stringify(edited));
  await writeFile(join(dir, 'src/brain/templates/jev-swarm-policy.jinja'), 'Custom conservative policy');
  const loaded = await loadSwarmPrompts(templates);
  expect(loaded.policy).toBe('Custom conservative policy');
  const state: SwarmSnapshot = { window: { since: '2026-09-21T00:00:00Z', until: '2026-09-21T00:05:00Z', pollIntervalMs: 30000, windowPolls: 10 },
    entities: [{ id: 'a', kind: 'arm', version: 'v1', state: { status: 'idle' } }],
    events: [{ id: 'e', actor: 'a', target: 'a', type: 'message', text: 'waiting', timestamp: '2026-09-21T00:04:00Z' }],
    brainActions: [], evaluations: [], discoveries: [], coverage: { complete: true, notes: [] } };
  expect(routingQuestions(candidatesFor(state), loaded.questions).action_0!.instructions).toStartWith('Custom question');
  const evaluator = new SwarmEvaluator('not-a-real-key', 'test', templates, { prompt_arm: 'off' });
  let sent: { state: Record<string, unknown>; questions: Record<string, { instructions: string; criteria: Record<string, string> }> } | undefined;
  (evaluator as unknown as { client: { systemOne: (input: NonNullable<typeof sent>) => Promise<unknown> } }).client = {
    systemOne: async (input) => {
      sent = input;
      return { answers: Object.fromEntries(Object.entries(input.questions).map(([key, question]) => [key, {
        type: 'choice', choice: 'not_needed', probabilities: Object.fromEntries(Object.keys(question.criteria).map(choice => [choice, choice === 'not_needed' ? 1 : 0])),
      }])) };
    },
  };
  await evaluator.evaluate(state);
  expect(sent!.state.evaluationPolicy).toBe('Custom conservative policy');
  expect(JSON.stringify(sent!.state.candidates)).not.toContain('prompt_arm');
  expect(sent!.questions.action_0!.instructions).toStartWith('Custom question');
  delete edited.routing.criteria.act;
  expect(() => parseSwarmQuestions(JSON.stringify(edited))).toThrow('keep the existing keys');
});

it('disables selected assistant-output effects without disabling task creation, and reloads settings', async () => {
  const brain = new Brain({ coleoDir: dir, pollIntervalMs: 30000, verbose: false });
  const calls: string[] = [];
  const internal = brain as unknown as {
    applyArmOutputDecision: (arm: Arm, decision: ArmOutputDecision, messages: []) => Promise<void>;
    sendPromptToArm: () => Promise<boolean>; createTaskViaApi: () => Promise<{ id: string }>;
    logActivity: () => void;
  };
  internal.sendPromptToArm = async () => { calls.push('prompt'); return true; };
  internal.createTaskViaApi = async () => { calls.push('task'); return { id: 'new-task' }; };
  internal.logActivity = () => {};
  const arm = { id: 'test', name: 'test' } as Arm;
  const decide = (action: ArmOutputDecision['action']) => internal.applyArmOutputDecision(arm,
    { action, confidence: 1, reasoning: 'test', armPrompt: 'Continue', task: { subject: 'Follow up', description: 'Details' } }, []);
  await updateConfig({ brain: { responsibilityEnabled: { followups: false, 'new-bugs': false, 'task-state': false } } }, dir);
  await decide('no_action'); await decide('log_bug'); await decide('update_task');
  expect(calls).toEqual([]);
  await decide('create_task');
  expect(calls).toEqual(['task']);
  await updateConfig({ brain: { responsibilityEnabled: { followups: true } } }, dir);
  await decide('no_action');
  expect(calls).toEqual(['task', 'prompt']);
});
