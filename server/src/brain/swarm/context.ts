import type { SwarmEvent, SwarmSnapshot } from "./types";

const TRANSPORT_ID = /^(?:message|part|session|call)[_-]?id$/i;

/** Strip transport identities from structured activity, including JSON encoded in text. */
function activityValue(value: unknown, parent = "", depth = 0): unknown {
  if (depth > 30) return value;
  if (typeof value === "string") {
    if (!/^\s*[\[{]/.test(value)) return value;
    try {
      return JSON.stringify(activityValue(JSON.parse(value), parent, depth + 1));
    } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(item => activityValue(item, parent, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !TRANSPORT_ID.test(key)
      && !(key === "id" && ["part", "info"].includes(parent))).map(([key, item]) =>
      [key, activityValue(item, key, depth + 1)]));
  }
  return value;
}

function modelEvent(event: SwarmEvent): Omit<SwarmEvent, "id"> {
  // The model selects an array position; the evaluator maps it back to the original
  // stable ID. Sending that ID (which embeds session/message/part IDs) adds no evidence.
  const { id: _id, ...context } = event;
  return { ...context, text: activityValue(event.text) as string };
}

/** Compact only the model view. Audit snapshots and execution references remain intact. */
export function swarmModelContext(snapshot: SwarmSnapshot): Omit<SwarmSnapshot, "events" | "brainActions"> & {
  events: Array<Omit<SwarmEvent, "id">>; brainActions: Array<Omit<SwarmEvent, "id">>;
} {
  return { ...snapshot,
    entities: snapshot.entities.map(entity => {
      const description = entity.state.description;
      if (entity.kind !== "task" || typeof description !== "string" || description.length <= 256) return entity;
      return { ...entity, state: { ...entity.state, description: description.slice(0, 256), descriptionTruncated: true } };
    }),
    events: snapshot.events.map(modelEvent),
    brainActions: snapshot.brainActions.map(modelEvent),
  };
}
