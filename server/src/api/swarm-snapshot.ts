import { eventMatchesProject, eventStore } from "../nats/jetstream";
import { getProjectScope } from "../project-scope";
import { listSwarmActions } from "../db/swarm-actions";
import { projectSwarmEvents } from "./swarm-events";
import type { Database } from "bun:sqlite";
import type { SwarmEntity, SwarmEvent, SwarmSnapshot } from "../brain/swarm/types";

interface EntityRow { id: string; updated_at: string; [key: string]: unknown }
function entity(row: EntityRow, kind: SwarmEntity["kind"]): SwarmEntity {
  const { id, updated_at, ...state } = row;
  return { id, kind, version: updated_at, state };
}

export async function collectSwarmSnapshot(db: Database, window: SwarmSnapshot["window"]): Promise<SwarmSnapshot> {
  const notes: string[] = [];
  const events: SwarmEvent[] = [];
  if (!eventStore.isInitialized()) notes.push("JetStream unavailable; activity history missing");
  else {
    // Scan beyond the context limit so streaming noise cannot displace finished messages.
    // This is an emergency ingestion bound, not a model context limit. Fail closed if hit.
    const scanLimit = 20000;
    const raw = await eventStore.queryEvents({ since: new Date(window.since), until: new Date(window.until),
      limit: scanLimit + 1, latest: true });
    if (raw.length > scanLimit) notes.push(`Raw activity scan exceeds ${scanLimit} records`);
    const projected = projectSwarmEvents(raw.filter((item) => eventMatchesProject(item, getProjectScope().projectKey)));
    events.push(...projected.events);
    notes.push(...projected.notes);
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  const arms = db.query(`SELECT id,name,status,current_task_id,planning_blocked,host,last_activity_at,last_output_at,updated_at FROM arms
    WHERE status NOT IN ('stopped','error') OR updated_at >= ?`).all(window.since) as EntityRow[];
  const armIds = new Set(arms.map((arm) => arm.id));
  // Retain referenced stopped arms too: their final messages can still need follow-up.
  for (const id of new Set(events.map((event) => event.actor))) {
    if (armIds.has(id)) continue;
    const row = db.query("SELECT id,name,status,current_task_id,planning_blocked,host,last_activity_at,last_output_at,updated_at FROM arms WHERE id=?").get(id) as EntityRow | null;
    if (row) { arms.push(row); armIds.add(id); }
  }
  const tasks = db.query(`SELECT id,subject,description,status,priority,assigned_to,blocked_reason,blocked_category,blocked_needs_human,dependency_blocked,updated_at FROM tasks
    WHERE updated_at >= ? OR assigned_to IS NOT NULL ORDER BY updated_at DESC LIMIT 101`).all(window.since) as EntityRow[];
  // Add task/bug references from any arm's event, even if the records are old.
  const context = events.map((event) => `${event.target || ""} ${event.text}`).join(" ");
  const references = new Set(context.match(/\b(?:task|bug|refactor|phase\d+)-[a-zA-Z0-9_-]+/g) || []);
  for (const arm of arms) if (typeof arm.current_task_id === "string") references.add(arm.current_task_id);
  for (const id of references) {
    if (tasks.some((task) => task.id === id)) continue;
    const row = db.query("SELECT id,subject,description,status,priority,assigned_to,blocked_reason,blocked_category,blocked_needs_human,dependency_blocked,updated_at FROM tasks WHERE id=?").get(id) as EntityRow | null;
    if (row) tasks.push(row);
  }
  if (tasks.length > 100) notes.push("Relevant task limit exceeded");
  const bugs = db.query(`SELECT id,title,description,status,priority,source_task_id,updated_at FROM bugs
    WHERE archived=0 AND (status NOT IN ('closed','resolved') OR updated_at >= ?) ORDER BY updated_at DESC LIMIT 101`).all(window.since) as EntityRow[];
  if (bugs.length > 100) notes.push("Bug limit exceeded");
  const discoveries = db.query(`SELECT id,title,details,task_id AS taskId,created_at AS createdAt,updated_at AS updatedAt FROM discoveries
    WHERE status='open' OR updated_at >= ? ORDER BY updated_at DESC LIMIT 101`).all(window.since) as SwarmSnapshot["discoveries"];
  if (discoveries.length > 100) notes.push("Discovery limit exceeded");
  return { window, entities: [...arms.map((row) => entity(row, "arm")),
    ...tasks.slice(0, 100).map((row) => entity(row, "task")), ...bugs.slice(0, 100).map((row) => entity(row, "bug"))],
  events: events.filter((event) => event.actor !== "brain"), brainActions: events.filter((event) => event.actor === "brain"),
  evaluations: listSwarmActions(db, window.since), discoveries: discoveries.slice(0, 100),
  coverage: { complete: notes.length === 0, notes: [...new Set(notes)] } };
}
