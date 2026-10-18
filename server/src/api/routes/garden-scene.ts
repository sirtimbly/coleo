import type { Database } from "bun:sqlite";

import { getBrainState } from "../../db/state";
import { getRecentActivity, getActiveClaims } from "./garden-utils";

export interface GardenVec3 {
  x: number;
  y: number;
  z: number;
}

export interface GardenSceneAnchor {
  id: string;
  label: string;
  kind: "workspace" | "domain" | "operations";
  position: GardenVec3;
  itemCount: number;
}

export interface GardenSceneBrain {
  id: "brain";
  label: string;
  position: GardenVec3;
  status: "stopped" | "running" | "paused";
  pollIntervalMs: number;
  lastPollAt?: string;
  pendingTasks: number;
  completedToday: number;
  completedTaskCount: number;
}

export interface GardenSceneArm {
  id: string;
  label: string;
  domain: string | null;
  position: GardenVec3;
  legacyStatus: string;
  lifecycleState: string | null;
  currentTaskId: string | null;
  currentTaskSubject: string | null;
  currentBugId: string | null;
  currentBugTitle: string | null;
  targetAnchorId: string | null;
  lastActivityAt: string | null;
  lastHeartbeatAt: string | null;
  lastOutputAt: string | null;
  workdir: string | null;
}

export interface GardenSceneTask {
  id: string;
  label: string;
  position: GardenVec3;
  status: string;
  priority: string;
  domain: string | null;
  classification: string | null;
  phase: string | null;
  assignedTo: string | null;
  anchorId: string;
  progress: number | null;
  updatedAt: string;
}

export interface GardenSceneBug {
  id: string;
  label: string;
  position: GardenVec3;
  status: string;
  priority: string;
  assigneeArmId: string | null;
  sourceTaskId: string | null;
}

export interface GardenSceneBubble {
  id: string;
  label: string;
  kind: "proposal" | "discovery" | "health";
  position: GardenVec3;
  status: string;
  severity?: string | null;
  phase?: string | null;
  sourceArmId?: string | null;
  taskId?: string | null;
}

export interface GardenSceneLink {
  id: string;
  kind: "brain_arm" | "task_assignment" | "claim" | "consensus";
  sourceId: string;
  targetId: string;
  weight: number;
  opacity: number;
  count?: number;
}

export interface GardenSceneStats {
  activeArms: number;
  visibleTasks: number;
  visibleBugs: number;
  visibleDiscoveries: number;
  openProposals: number;
  activeClaims: number;
  conflictZones: number;
  recentActivity: number;
}

export interface GardenScene {
  generatedAt: string;
  brain: GardenSceneBrain;
  anchors: GardenSceneAnchor[];
  arms: GardenSceneArm[];
  tasks: GardenSceneTask[];
  bugs: GardenSceneBug[];
  bubbles: GardenSceneBubble[];
  links: GardenSceneLink[];
  stats: GardenSceneStats;
}

interface ArmSceneRow {
  id: string;
  name: string;
  domain: string | null;
  status: string;
  current_task_id: string | null;
  current_task_subject: string | null;
  current_bug_id: string | null;
  current_bug_title: string | null;
  last_activity_at: string | null;
  last_heartbeat: string | null;
  last_output_at: string | null;
  workdir: string | null;
  lifecycle_state: string | null;
}

interface TaskSceneRow {
  id: string;
  subject: string;
  status: string;
  priority: string;
  domain: string | null;
  classification: string | null;
  phase: string | null;
  assigned_to: string | null;
  progress: number | null;
  updated_at: string;
}

interface BugSceneRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee_arm_id: string | null;
  source_task_id: string | null;
  updated_at: string;
}

interface DiscoverySceneRow {
  id: string;
  title: string;
  status: string;
  severity: string | null;
  phase: string | null;
  arm_id: string | null;
  task_id: string | null;
  file_path: string | null;
  updated_at: string;
}

interface ProposalSceneRow {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

interface HealthSceneRow {
  component: string;
  healthy: number;
  optional: number;
  updated_at: string;
}

interface ConsensusSceneRow {
  task_id: string;
  arm_id: string;
  role: string;
  status: string;
}

interface ClaimSceneRow {
  id: number;
  armId: string;
  filePath: string;
  claimType: "read" | "write" | "exclusive";
  claimedAt: string;
  releasedAt: string | null;
}

const BRAIN_POSITION: GardenVec3 = { x: 0, y: 2, z: 0 };
const TWO_PI = Math.PI * 2;

function safeAll<T extends object>(
  db: Database,
  sql: string,
  params: Array<string | number> = [],
): T[] {
  try {
    return db.query(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function hashString(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function polarPosition(index: number, total: number, radius: number, y: number, seed = 0): GardenVec3 {
  const safeTotal = Math.max(total, 1);
  const angle = (index / safeTotal) * TWO_PI + seed * 0.01;
  return {
    x: Math.cos(angle) * radius,
    y,
    z: Math.sin(angle) * radius,
  };
}

function offsetAround(origin: GardenVec3, index: number, total: number, radius: number, seed = 0): GardenVec3 {
  const local = polarPosition(index, total, radius, 0, seed);
  const verticalWave = ((hashString(`${seed}:${index}`) % 11) - 5) * 0.35;
  return {
    x: origin.x + local.x,
    y: origin.y + verticalWave,
    z: origin.z + local.z,
  };
}

function hashFraction(input: string): number {
  return (hashString(input) % 10000) / 10000;
}

function ageDepth(updatedAt: string, newestY: number, oldestY: number, maxAgeDays: number): number {
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) {
    return newestY;
  }
  const ageMs = Math.max(0, Date.now() - parsed);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const normalized = clamp(ageDays / Math.max(maxAgeDays, 1), 0, 1);
  return newestY + (oldestY - newestY) * normalized;
}

function reefHashPosition(
  id: string,
  updatedAt: string,
  radius: number,
  radialJitter: number,
  newestY: number,
  oldestY: number,
  maxAgeDays: number,
): GardenVec3 {
  const angle = hashFraction(`${id}:angle`) * TWO_PI;
  const ringRadius = radius + (hashFraction(`${id}:radius`) - 0.5) * radialJitter;
  const tangentOffset = (hashFraction(`${id}:tangent`) - 0.5) * 2.4;
  return {
    x: BRAIN_POSITION.x + Math.cos(angle) * ringRadius - Math.sin(angle) * tangentOffset,
    y: ageDepth(updatedAt, newestY, oldestY, maxAgeDays),
    z: BRAIN_POSITION.z + Math.sin(angle) * ringRadius + Math.cos(angle) * tangentOffset,
  };
}

function lerpPosition(from: GardenVec3, to: GardenVec3, amount: number): GardenVec3 {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    z: from.z + (to.z - from.z) * amount,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function topLevelBucket(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length === 0) return "workspace";
  if (parts[0] === "src" && parts[1]) {
    return `src/${parts[1]}`;
  }
  if (parts[0]?.startsWith(".")) {
    return parts[0];
  }
  return parts[0] || "workspace";
}

function anchorLabelFromKey(key: string): string {
  if (key.startsWith("domain:")) {
    return key.slice("domain:".length);
  }
  if (key.startsWith("ops:")) {
    return key.slice("ops:".length);
  }
  return key;
}

function anchorKindFromKey(key: string): GardenSceneAnchor["kind"] {
  if (key.startsWith("domain:")) {
    return "domain";
  }
  if (key.startsWith("ops:")) {
    return "operations";
  }
  return "workspace";
}

function normalizeTaskAnchor(task: TaskSceneRow): string {
  if (task.domain) {
    return `domain:${task.domain}`;
  }
  if (task.classification) {
    return `domain:${task.classification}`;
  }
  if (task.phase) {
    return `ops:${task.phase}`;
  }
  return "domain:general";
}

function activityStateForArm(row: ArmSceneRow): string {
  const lifecycle = row.lifecycle_state || "";
  if (lifecycle === "working" || lifecycle === "task_assigned" || lifecycle === "completing") {
    return lifecycle;
  }
  if (lifecycle) {
    return lifecycle;
  }
  return row.status;
}

function interpolationForArm(row: ArmSceneRow): number {
  const activityState = activityStateForArm(row);
  switch (activityState) {
    case "working":
      return 0.72;
    case "completing":
      return 0.64;
    case "task_assigned":
      return 0.56;
    case "error":
      return 0.34;
    case "disconnected":
      return 0.24;
    case "starting":
    case "spawning":
      return 0.18;
    case "stopped":
      return 0.12;
    case "idle":
    default:
      return 0.36;
  }
}

function bubbleStatusFromHealth(row: HealthSceneRow): string {
  if (row.healthy === 1) return row.optional === 1 ? "optional" : "healthy";
  return row.optional === 1 ? "optional_warning" : "error";
}

export async function buildGardenScene(db: Database): Promise<GardenScene> {
  const generatedAt = new Date().toISOString();
  const brainState = getBrainState(db);
  const claims = getActiveClaims(db) as ClaimSceneRow[];
  const recentActivity = await getRecentActivity();

  const arms = safeAll<ArmSceneRow>(
    db,
    `
      SELECT
        a.id,
        a.name,
        a.domain,
        a.status,
        a.current_task_id,
        a.current_task_subject,
        a.current_bug_id,
        a.current_bug_title,
        a.last_activity_at,
        a.last_heartbeat,
        a.last_output_at,
        a.workdir,
        asm.state AS lifecycle_state
      FROM arms a
      LEFT JOIN arm_state_machine asm ON asm.arm_id = a.id
      ORDER BY a.updated_at DESC, a.created_at ASC
    `,
  );

  const tasks = safeAll<TaskSceneRow>(
    db,
    `
      SELECT
        t.id,
        t.subject,
        t.status,
        t.priority,
        t.domain,
        t.classification,
        t.phase,
        t.assigned_to,
        t.progress,
        t.updated_at
      FROM tasks t
      WHERE t.status IN ('pending', 'claimed', 'in_progress', 'completing', 'blocked')
         OR (t.status = 'completed' AND t.updated_at >= datetime('now', '-2 days'))
      ORDER BY
        CASE t.status
          WHEN 'in_progress' THEN 0
          WHEN 'completing' THEN 1
          WHEN 'claimed' THEN 2
          WHEN 'blocked' THEN 3
          WHEN 'pending' THEN 4
          ELSE 5
        END,
        CASE t.priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'normal' THEN 2
          ELSE 3
        END,
        t.updated_at DESC
      LIMIT 36
    `,
  );

  const bugs = safeAll<BugSceneRow>(
    db,
    `
      SELECT
        id,
        title,
        status,
        priority,
        assignee_arm_id,
        source_task_id,
        updated_at
      FROM bugs
      WHERE archived = 0
      ORDER BY
        CASE status
          WHEN 'open' THEN 0
          WHEN 'investigating' THEN 1
          WHEN 'fixing' THEN 2
          WHEN 'verifying' THEN 3
          ELSE 4
        END,
        CASE priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          ELSE 3
        END,
        updated_at DESC
      LIMIT 20
    `,
  );

  const discoveries = safeAll<DiscoverySceneRow>(
    db,
    `
      SELECT
        id,
        title,
        status,
        severity,
        phase,
        arm_id,
        task_id,
        file_path,
        updated_at
      FROM discoveries
      WHERE status IN ('open', 'acknowledged')
      ORDER BY
        CASE severity
          WHEN 'error' THEN 0
          WHEN 'warning' THEN 1
          ELSE 2
        END,
        updated_at DESC
      LIMIT 30
    `,
  );

  const proposals = safeAll<ProposalSceneRow>(
    db,
    `
      SELECT id, title, status, updated_at
      FROM proposals
      WHERE status = 'open' OR updated_at >= datetime('now', '-2 days')
      ORDER BY
        CASE status WHEN 'open' THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 12
    `,
  );

  const healthRows = safeAll<HealthSceneRow>(
    db,
    `
      SELECT component, healthy, optional, updated_at
      FROM infrastructure_health
      ORDER BY optional ASC, component ASC
    `,
  );

  const consensusRows = safeAll<ConsensusSceneRow>(
    db,
    `
      SELECT task_id, arm_id, role, status
      FROM task_arm_consensus
      WHERE status IN ('pending', 'working', 'watching')
      ORDER BY updated_at DESC
      LIMIT 80
    `,
  );

  const anchorCounts = new Map<string, number>();
  const ensureAnchor = (key: string): void => {
    anchorCounts.set(key, (anchorCounts.get(key) || 0) + 1);
  };

  for (const claim of claims) {
    ensureAnchor(topLevelBucket(claim.filePath));
  }
  for (const entry of recentActivity) {
    if (entry.target) {
      ensureAnchor(topLevelBucket(entry.target));
    }
  }
  for (const task of tasks) {
    ensureAnchor(normalizeTaskAnchor(task));
  }
  for (const discovery of discoveries) {
    if (discovery.file_path) {
      ensureAnchor(topLevelBucket(discovery.file_path));
    } else if (discovery.task_id) {
      const task = tasks.find((item) => item.id === discovery.task_id);
      ensureAnchor(task ? normalizeTaskAnchor(task) : "ops:discoveries");
    } else {
      ensureAnchor("ops:discoveries");
    }
  }
  for (const arm of arms) {
    if (arm.workdir) {
      ensureAnchor(topLevelBucket(arm.workdir));
    }
  }
  ensureAnchor("ops:bugs");
  ensureAnchor("ops:health");

  const anchorKeys = Array.from(anchorCounts.keys()).sort((left, right) => left.localeCompare(right));
  const anchors: GardenSceneAnchor[] = anchorKeys.map((key, index) => {
    const kind = anchorKindFromKey(key);
    const baseRadius = kind === "workspace" ? 34 : kind === "domain" ? 28 : 24;
    const y = kind === "workspace" ? -2 : kind === "domain" ? 4 : 8;
    return {
      id: `anchor:${key}`,
      label: anchorLabelFromKey(key),
      kind,
      position: polarPosition(index, anchorKeys.length, baseRadius, y, hashString(key)),
      itemCount: anchorCounts.get(key) || 0,
    };
  });

  const anchorMap = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const anchorIdByKey = new Map(anchorKeys.map((key) => [key, `anchor:${key}`]));

  const taskGroups = new Map<string, TaskSceneRow[]>();
  for (const task of tasks) {
    const anchorKey = normalizeTaskAnchor(task);
    const anchorId = anchorIdByKey.get(anchorKey) || `anchor:${anchorKey}`;
    const group = taskGroups.get(anchorId) || [];
    group.push(task);
    taskGroups.set(anchorId, group);
  }

  const sceneTasks: GardenSceneTask[] = [];
  const taskPositionMap = new Map<string, GardenSceneTask>();
  for (const [anchorId, group] of taskGroups.entries()) {
    const anchor = anchorMap.get(anchorId);
    if (!anchor) continue;
    for (const [index, task] of group.entries()) {
      const position = offsetAround(anchor.position, index, group.length, 5.2, hashString(task.id));
      position.y += task.status === "blocked" ? 4 : task.status === "completed" ? -2 : 1;

      const sceneTask: GardenSceneTask = {
        id: task.id,
        label: task.subject,
        position,
        status: task.status,
        priority: task.priority,
        domain: task.domain,
        classification: task.classification,
        phase: task.phase,
        assignedTo: task.assigned_to,
        anchorId,
        progress: task.progress,
        updatedAt: task.updated_at,
      };
      sceneTasks.push(sceneTask);
      taskPositionMap.set(task.id, sceneTask);
    }
  }

  const sceneBugs: GardenSceneBug[] = [];
  const bugPositionMap = new Map<string, GardenSceneBug>();
  for (const bug of bugs) {
    const position = reefHashPosition(bug.id, bug.updated_at, 76, 4.2, -1.6, -6.4, 21);

    const sceneBug: GardenSceneBug = {
      id: bug.id,
      label: bug.title,
      position,
      status: bug.status,
      priority: bug.priority,
      assigneeArmId: bug.assignee_arm_id,
      sourceTaskId: bug.source_task_id,
    };
    sceneBugs.push(sceneBug);
    bugPositionMap.set(bug.id, sceneBug);
  }

  const bubbles: GardenSceneBubble[] = [];
  for (const discovery of discoveries) {
    const position = reefHashPosition(discovery.id, discovery.updated_at, 90, 5.8, -0.8, -5.8, 21);
    bubbles.push({
      id: discovery.id,
      label: discovery.title,
      kind: "discovery",
      position,
      status: discovery.status,
      severity: discovery.severity,
      phase: discovery.phase,
      sourceArmId: discovery.arm_id,
      taskId: discovery.task_id,
    });
  }

  for (const [index, proposal] of proposals.entries()) {
    const position = polarPosition(index, proposals.length, 12, 10, hashString(proposal.id));
    position.y += ((index % 3) - 1) * 1.2;
    bubbles.push({
      id: proposal.id,
      label: proposal.title,
      kind: "proposal",
      position,
      status: proposal.status,
    });
  }

  const healthAnchor = anchorMap.get(anchorIdByKey.get("ops:health") || "");
  for (const [index, health] of healthRows.entries()) {
    const origin = healthAnchor?.position || { x: 0, y: 12, z: -28 };
    const position = offsetAround(origin, index, healthRows.length, 4.2, hashString(health.component));
    position.y += 3;
    bubbles.push({
      id: `health:${health.component}`,
      label: health.component,
      kind: "health",
      position,
      status: bubbleStatusFromHealth(health),
    });
  }

  const sceneArms: GardenSceneArm[] = [];
  const armPositionMap = new Map<string, GardenSceneArm>();
  const armClaimsByAnchor = new Map<string, number>();

  for (const claim of claims) {
    const anchorKey = topLevelBucket(claim.filePath);
    const anchorId = anchorIdByKey.get(anchorKey);
    if (!anchorId) continue;
    const pairKey = `${claim.armId}::${anchorId}`;
    armClaimsByAnchor.set(pairKey, (armClaimsByAnchor.get(pairKey) || 0) + 1);
  }

  for (const [index, arm] of arms.entries()) {
    let targetAnchorId: string | null = null;
    let targetPosition: GardenVec3 | null = null;

    if (arm.current_task_id && taskPositionMap.has(arm.current_task_id)) {
      const task = taskPositionMap.get(arm.current_task_id)!;
      targetAnchorId = task.anchorId;
      targetPosition = task.position;
    } else if (arm.current_bug_id && bugPositionMap.has(arm.current_bug_id)) {
      const bug = bugPositionMap.get(arm.current_bug_id)!;
      targetAnchorId = "anchor:ops:bugs";
      targetPosition = bug.position;
    } else if (arm.workdir) {
      const workdirAnchorId = anchorIdByKey.get(topLevelBucket(arm.workdir));
      if (workdirAnchorId && anchorMap.has(workdirAnchorId)) {
        targetAnchorId = workdirAnchorId;
        targetPosition = anchorMap.get(workdirAnchorId)!.position;
      }
    }

    if (!targetPosition) {
      targetPosition = polarPosition(index, arms.length, 16, 4, hashString(arm.id));
    }

    const baseIdlePosition = polarPosition(index, arms.length, 16, 4, hashString(arm.id));
    const position = lerpPosition(baseIdlePosition, targetPosition, clamp(interpolationForArm(arm), 0.1, 0.82));
    position.y += ((hashString(`arm:${arm.id}`) % 9) - 4) * 0.2;

    const sceneArm: GardenSceneArm = {
      id: arm.id,
      label: arm.name,
      domain: arm.domain,
      position,
      legacyStatus: arm.status,
      lifecycleState: arm.lifecycle_state,
      currentTaskId: arm.current_task_id,
      currentTaskSubject: arm.current_task_subject,
      currentBugId: arm.current_bug_id,
      currentBugTitle: arm.current_bug_title,
      targetAnchorId,
      lastActivityAt: arm.last_activity_at,
      lastHeartbeatAt: arm.last_heartbeat,
      lastOutputAt: arm.last_output_at,
      workdir: arm.workdir,
    };
    sceneArms.push(sceneArm);
    armPositionMap.set(arm.id, sceneArm);
  }

  const links: GardenSceneLink[] = [];
  for (const arm of sceneArms) {
    links.push({
      id: `brain-arm:${arm.id}`,
      kind: "brain_arm",
      sourceId: "brain",
      targetId: arm.id,
      weight: 1,
      opacity: 0.18,
    });
    if (arm.currentTaskId && taskPositionMap.has(arm.currentTaskId)) {
      links.push({
        id: `arm-task:${arm.id}:${arm.currentTaskId}`,
        kind: "task_assignment",
        sourceId: arm.id,
        targetId: arm.currentTaskId,
        weight: 1.4,
        opacity: 0.3,
      });
    }
  }

  for (const [pairKey, count] of armClaimsByAnchor.entries()) {
    const [armId, anchorId] = pairKey.split("::");
    if (!armId || !anchorId || !armPositionMap.has(armId) || !anchorMap.has(anchorId)) {
      continue;
    }
    links.push({
      id: `claim:${armId}:${anchorId}`,
      kind: "claim",
      sourceId: armId,
      targetId: anchorId,
      weight: clamp(0.6 + count * 0.08, 0.6, 2.2),
      opacity: clamp(0.1 + count * 0.015, 0.1, 0.24),
      count,
    });
  }

  for (const consensus of consensusRows) {
    if (!armPositionMap.has(consensus.arm_id) || !taskPositionMap.has(consensus.task_id)) {
      continue;
    }
    links.push({
      id: `consensus:${consensus.arm_id}:${consensus.task_id}:${consensus.role}`,
      kind: "consensus",
      sourceId: consensus.arm_id,
      targetId: consensus.task_id,
      weight: consensus.role === "watcher" ? 0.7 : 1,
      opacity: consensus.role === "watcher" ? 0.14 : 0.2,
    });
  }

  const claimsByPath = new Map<string, Set<string>>();
  for (const claim of claims) {
    const owners = claimsByPath.get(claim.filePath) || new Set<string>();
    owners.add(claim.armId);
    claimsByPath.set(claim.filePath, owners);
  }

  return {
    generatedAt,
    brain: {
      id: "brain",
      label: "Brain",
      position: BRAIN_POSITION,
      status: brainState.status,
      pollIntervalMs: brainState.pollIntervalMs,
      lastPollAt: brainState.lastPollAt,
      pendingTasks: brainState.pendingTasks,
      completedToday: brainState.completedToday,
      completedTaskCount: brainState.completedTaskCount,
    },
    anchors,
    arms: sceneArms,
    tasks: sceneTasks,
    bugs: sceneBugs,
    bubbles,
    links,
    stats: {
      activeArms: sceneArms.filter((arm) => arm.legacyStatus !== "stopped" && arm.legacyStatus !== "error").length,
      visibleTasks: sceneTasks.length,
      visibleBugs: sceneBugs.length,
      visibleDiscoveries: bubbles.filter((bubble) => bubble.kind === "discovery").length,
      openProposals: bubbles.filter((bubble) => bubble.kind === "proposal" && bubble.status === "open").length,
      activeClaims: claims.length,
      conflictZones: Array.from(claimsByPath.values()).filter((owners) => owners.size > 1).length,
      recentActivity: recentActivity.length,
    },
  };
}
