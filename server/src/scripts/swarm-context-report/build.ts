#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { candidatesFor, routingQuestions, sharedRubrics } from "../../brain/swarm/evaluator";
import { parseSwarmQuestions } from "../../brain/swarm/prompts";
import { projectSwarmEvents } from "../../api/swarm-events";
import { swarmModelContext } from "../../brain/swarm/context";
import { fitSwarmRequest } from "../../brain/swarm/budget";
import type { EventData } from "../../nats/jetstream-types";
import type { SwarmSnapshot } from "../../brain/swarm/types";

interface TreeNode {
  name: string; path: string; size: number; type: string; group: string;
  preview?: string; clipped?: boolean; children?: TreeNode[];
}
const clean = (text: string): string => text
  .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED KEY]")
  .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [REDACTED]")
  .replace(/(["']?(?:api[_-]?key|authorization|password|secret|access_token)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[REDACTED]");
const secret = (key: string) => /api.?key|authorization|password|secret|token$/i.test(key);
const encode = (text: string, depth: number): string => {
  for (let i = 0; i < depth; i++) text = JSON.stringify(text).slice(1, -1);
  return text;
};
function tree(value: unknown, path: string, name: string, group: string, depth = 0, charge = 0,
  nesting = 0): TreeNode {
  const serialized = JSON.stringify(value);
  const node: TreeNode = { name: clean(name), path, group,
    size: encode(serialized, depth).length + charge,
    type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value };
  if (secret(name)) { node.preview = "[REDACTED]"; return node; }
  if (typeof value === "string") {
    node.preview = clean(value).slice(0, 12000);
    node.clipped = value.length > 12000;
    if (nesting < 12 && /^[\[{]/.test(value)) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          const decoded = tree(parsed, `${path} (decoded)`, name, group, depth + 1, 0, nesting + 1);
          node.type = "JSON inside string";
          node.children = decoded.children;
        }
      } catch { /* Historical payloads may have been truncated mid-JSON. */ }
    }
  } else if (value && typeof value === "object") {
    node.children = Object.entries(value).map(([key, child]) => {
      const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
      const childGroup = path === "$.state" ? key : path === "$" && key === "questions" ? "questions" : group;
      let label = key;
      if (Array.isArray(value) && child && typeof child === "object") {
        const item = child as Record<string, unknown>;
        const state = item.state as Record<string, unknown> | undefined;
        const title = item.title || item.action || state?.subject || state?.title || item.type || item.id;
        if (title) label = `[${key}] ${item.kind ? `${item.kind} · ` : ""}${String(title)}`;
      }
      const fieldCharge = Array.isArray(value) ? 0 : encode(`${JSON.stringify(key)}:`, depth).length;
      return tree(child, childPath, label, childGroup, depth, fieldCharge, nesting + 1);
    });
  } else node.preview = serialized;
  if (node.children) {
    const occupied = node.children.reduce((sum, child) => sum + child.size, 0);
    const overhead = node.size - occupied;
    if (overhead < 0) { delete node.children; } // Preserve exact areas if a decoded string uses noncanonical formatting.
    else if (overhead) node.children.push({ name: "JSON syntax", path: `${path} (syntax)`, size: overhead,
      type: "syntax", group, preview: "Property labels, separators, braces, quotes and escaping not assigned to child values." });
    if (!node.children?.length) delete node.children;
  }
  return node;
}

const report = await Bun.file("reports/jev-completed-context-experiment.json").json() as {
  largest: { id: string }; measurements: Array<{ id: string; at: string; historicalError: string | null;
    sizes: { original: { events: number }; completed_activity: { queryChars: number } } }>;
};
const measurements = report.measurements;
const choices = [
  { label: "Light activity", row: measurements.find(m => m.sizes.original.events > 0 && !m.historicalError)! },
  { label: "First budget failure", row: measurements.find(m => m.historicalError)! },
  { label: "Busy arm", row: measurements.find(m => m.sizes.original.events >= 350 && m.sizes.original.events < 600)! },
  { label: "Largest window (was ~177k)", row: measurements.find(m => m.id === report.largest.id)! },
];
const config = Bun.TOML.parse(await Bun.file(".coleo/config.toml").text()) as {
  brain?: { swarm_action_modes?: Record<string, string> };
};
const modes = config.brain?.swarm_action_modes ?? {};
const policy = await Bun.file(".coleo/src/brain/templates/jev-swarm-policy.jinja").text();
const questionText = parseSwarmQuestions(await Bun.file(".coleo/src/brain/templates/jev-swarm-questions.jinja").text());
const previousHtml = await Bun.file("reports/jev-context-treemap.html").text();
const previousData = JSON.parse(previousHtml.match(/<script type="application\/json" id="payload-data">([\s\S]*?)<\/script>/)![1]!) as {
  samples: Array<{ id: string; trees: Record<string, TreeNode> }> };
const db = new Database(".coleo/coleo.db", { readonly: true });
const samples = choices.map(({ label, row }) => {
  const saved = db.query<{ snapshot: string; result: string }, [string]>(
    "SELECT snapshot,result FROM brain_swarm_evaluations WHERE id=?").get(row.id)!;
  const snapshot = JSON.parse(saved.snapshot) as SwarmSnapshot;
  const raw: EventData[] = [];
  let unavailable = 0;
  for (const event of [...snapshot.events, ...snapshot.brainActions]) {
    try {
      raw.push({ type: event.type, timestamp: event.timestamp, armId: event.actor,
        sequence: Number(event.id.match(/^event-(\d+):/)?.[1]) || undefined,
        data: JSON.parse(event.text) as Record<string, unknown> });
    } catch { unavailable++; }
  }
  const projected = projectSwarmEvents(raw);
  const notes = [...snapshot.coverage.notes, ...projected.notes,
    ...(unavailable ? [`${unavailable} historical payloads were already truncated and could not be replayed`] : [])];
  const completed: SwarmSnapshot = { ...snapshot,
    events: projected.events.filter(e => e.actor !== "brain"), brainActions: projected.events.filter(e => e.actor === "brain"),
    coverage: { complete: snapshot.coverage.complete && notes.length === 0, notes } };
  const candidates = candidatesFor(snapshot).filter(c => modes[c.action] !== "off");
  const questions = routingQuestions(candidates, questionText);
  const pack = (state: SwarmSnapshot | ReturnType<typeof swarmModelContext>) => ({ state: { evaluationPolicy: policy, ...state,
    candidates: candidates.map(c => ({ action: c.action, targetId: c.entity.id, targetType: c.entity.kind })) }, questions });
  const makeTree = (request: unknown) => {
    const root = tree(request, "$", "Full request", "syntax");
    // Flatten the state wrapper in the overview; paths still show the actual wire structure.
    root.children = root.children!.flatMap(n => n.path === "$.state" ? n.children ?? [n] : [n]);
    const verify = (node: TreeNode): void => {
      if (node.children) {
        if (node.children.reduce((sum, child) => sum + child.size, 0) !== node.size) {
          throw new Error(`Area accounting mismatch: ${node.path}`);
        }
        node.children.forEach(verify);
      }
    };
    verify(root);
    return root;
  };
  const prior = previousData.samples.find(s => s.id === row.id)!;
  const build = (s: SwarmSnapshot) => {
    const request = pack(swarmModelContext(s));
    return { ...request, state: { ...request.state, rubrics: sharedRubrics(questionText) } };
  };
  const fitted = fitSwarmRequest(completed, build);
  const result = JSON.parse(saved.result) as { error?: string; elapsedMs?: number };
  return { label, id: row.id, at: row.at, window: snapshot.window, unavailable,
    historicalOutcome: result.error || (result.elapsedMs ? `Model evaluation completed in ${Math.round(result.elapsedMs)} ms` : "No model call: empty activity"),
    complete: completed.coverage.complete, originalEvents: snapshot.events.length, completedEvents: completed.events.length,
    fittedEvents: fitted.snapshot.events.length, reduction: fitted.reduction,
    trees: { model: prior.trees.model!, completed: prior.trees.completed!, original: prior.trees.original!,
      shared: makeTree(build(completed)), fitted: makeTree({ state: fitted.state, questions: fitted.questions }) } };
});
db.close();
const data = JSON.stringify({ generatedAt: new Date().toISOString(), samples, modes }).replace(/</g, "\\u003c");
const template = await Bun.file(new URL("./template.html", import.meta.url)).text();
const output = "reports/jev-context-treemap.html";
await Bun.write(output, template.replace("/*__PAYLOAD_DATA__*/", data));
console.log(JSON.stringify({ output, samples: samples.map(s => ({ label: s.label,
  original: s.trees.original.size, completed: s.trees.completed.size, model: s.trees.model.size, shared: s.trees.shared.size, fitted: s.trees.fitted.size, unavailable: s.unavailable })) }, null, 2));
