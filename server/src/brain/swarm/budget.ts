import type { SwarmSnapshot } from "./types";

export interface BudgetQuestion { type: "choice"; instructions: string; criteria: Record<string, string | null> }
export type BudgetQuestions = Record<string, BudgetQuestion>;
export interface ContextReduction {
  initialChars: number; finalChars: number; eventsOmitted: number; discoveryDetailsShortened: number;
  entityDescriptionsShortened: number; iterations: number; retries: number;
}
export interface FittedRequest {
  state: Record<string, unknown>; questions: BudgetQuestions; snapshot: SwarmSnapshot; reduction: ContextReduction;
}
// Jev documents 64k total tokens and 32k for state + longest question. No public
// tokenizer is provided. These are conservative byte/character proxies, not exact
// token counts. Size-specific API rejections trigger further shrinking below.
export const DEFAULT_CONTEXT_BUDGET = { totalChars: 100000, stateAndQuestionBytes: 90000 };
export function fitSwarmRequest(source: SwarmSnapshot,
  build: (snapshot: SwarmSnapshot) => { state: Record<string, unknown>; questions: BudgetQuestions },
  budget = DEFAULT_CONTEXT_BUDGET, retries = 0): FittedRequest {
  const snapshot: SwarmSnapshot = { ...source, events: [...source.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    discoveries: source.discoveries.map(d => ({ ...d })), entities: source.entities.map(e => ({ ...e, state: { ...e.state } })) };
  const reduction: ContextReduction = { initialChars: 0, finalChars: 0, eventsOmitted: 0,
    discoveryDetailsShortened: 0, entityDescriptionsShortened: 0, iterations: 0, retries };
  while (true) {
    const request = build(snapshot);
    const state = { ...request.state, contextSelection: {
      eventsOmitted: reduction.eventsOmitted, discoveryDetailsShortened: reduction.discoveryDetailsShortened,
      entityDescriptionsShortened: reduction.entityDescriptionsShortened,
      note: "Older activity and long details may be omitted. Absence is not evidence of failure or resolution; check existing records and prior actions.",
    } };
    const chars = JSON.stringify({ state, questions: request.questions }).length;
    if (!reduction.iterations) reduction.initialChars = chars;
    const longest = Math.max(0, ...Object.values(request.questions).map(q => Buffer.byteLength(JSON.stringify(q))));
    const optionsFit = Object.values(request.questions).every(q => Object.keys(q.criteria).length <= 255);
    if (chars <= budget.totalChars && Buffer.byteLength(JSON.stringify(state)) + longest <= budget.stateAndQuestionBytes && optionsFit) {
      reduction.finalChars = chars;
      return { state, questions: request.questions, snapshot, reduction };
    }
    // Preserve every discovery's compact identity/title for duplicate detection.
    // New snapshots have timestamps; legacy snapshots are already newest-first.
    const olderDiscoveries = snapshot.discoveries.map((d, i) => ({ d, i }))
      .filter(({ d }) => d.details.length > 256).sort((a, b) => {
        const at = Date.parse(a.d.updatedAt || a.d.createdAt || ""), bt = Date.parse(b.d.updatedAt || b.d.createdAt || "");
        return Number.isFinite(at) && Number.isFinite(bt) ? at - bt : b.i - a.i;
      });
    if (olderDiscoveries.length && (reduction.iterations % 2 === 0 || snapshot.events.length <= 1)) {
      const oldest = olderDiscoveries[0]!.d;
      oldest.details = oldest.details.slice(0, 256); oldest.detailsTruncated = true;
      reduction.discoveryDetailsShortened++;
    } else if (snapshot.events.length > 1) {
      // Remove whole oldest records, retaining the most recent evidence and intact text.
      const count = Math.min(snapshot.events.length - 1, Math.max(1, Math.ceil(snapshot.events.length * .1)));
      snapshot.events.splice(0, count); reduction.eventsOmitted += count;
    } else {
      const large = snapshot.entities.filter(e => typeof e.state.description === "string" && e.state.description.length > 256)
        .sort((a, b) => Date.parse(a.version) - Date.parse(b.version))[0];
      if (!large) throw new Error("Swarm protected state and questions cannot fit the context budget; no evidence or prior actions were silently discarded");
      large.state.description = (large.state.description as string).slice(0, 256);
      large.state.descriptionTruncated = true; reduction.entityDescriptionsShortened++;
    }
    reduction.iterations++;
  }
}

export function isContextSizeError(error: unknown): boolean {
  const item = error as { status?: number; message?: string; error?: unknown } | null;
  if (!item || ![400,413,422].includes(item.status ?? 0)) return false;
  return /(?:context|tokens?|input|request).{0,80}(?:too (?:long|large)|exceed|maximum|limit)|(?:too (?:long|large)|exceed).{0,80}(?:context|tokens?|input|request)/i
    .test(`${item.message || ""} ${JSON.stringify(item.error ?? "")}`);
}
