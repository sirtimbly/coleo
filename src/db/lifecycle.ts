/**
 * Durable task lifecycle persistence.
 *
 * Provides typed access to task passes, leases, decisions, file references,
 * and dependency events. These records support the branch-centered task
 * lifecycle (implement → review → polish → human review → merge) while
 * preserving progressive planning's single-next-task model.
 */

import type { Database } from "bun:sqlite";

// ============================================
// Task Passes
// ============================================

export type TaskPassType =
  | "implement"
  | "review"
  | "polish"
  | "human_review"
  | "merge";

export type TaskPassStatus = "active" | "completed" | "failed" | "cancelled";

export interface TaskPass {
  id: string;
  taskId: string;
  passNumber: number;
  passType: TaskPassType;
  status: TaskPassStatus;
  startedAt: string;
  endedAt?: string;
  leaseId?: string;
  branchName?: string;
  baseBranch?: string;
  headCommit?: string;
  baseCommit?: string;
  resultSummary?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPassInput {
  id: string;
  taskId: string;
  passNumber: number;
  passType: TaskPassType;
  status?: TaskPassStatus;
  startedAt?: string;
  leaseId?: string;
  branchName?: string;
  baseBranch?: string;
  headCommit?: string;
  baseCommit?: string;
  resultSummary?: string;
  metadata?: Record<string, unknown>;
}

export function createTaskPass(db: Database, pass: TaskPassInput): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO task_passes (
      id, task_id, pass_number, pass_type, status, started_at,
      lease_id, branch_name, base_branch, head_commit, base_commit,
      result_summary, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pass.id,
      pass.taskId,
      pass.passNumber,
      pass.passType,
      pass.status ?? "active",
      pass.startedAt ?? now,
      pass.leaseId ?? null,
      pass.branchName ?? null,
      pass.baseBranch ?? null,
      pass.headCommit ?? null,
      pass.baseCommit ?? null,
      pass.resultSummary ?? null,
      JSON.stringify(pass.metadata ?? {}),
      now,
      now,
    ],
  );
}

export function getTaskPass(db: Database, passId: string): TaskPass | null {
  const row = db.query("SELECT * FROM task_passes WHERE id = ?").get(passId) as TaskPassRow | null;
  return row ? rowToTaskPass(row) : null;
}

export function getTaskPasses(
  db: Database,
  taskId: string,
  options?: { status?: TaskPassStatus; limit?: number },
): TaskPass[] {
  let query = "SELECT * FROM task_passes WHERE task_id = ?";
  const params: (string | number)[] = [taskId];
  if (options?.status) {
    query += " AND status = ?";
    params.push(options.status);
  }
  query += " ORDER BY pass_number DESC";
  if (options?.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }
  const rows = db.query(query).all(...params) as TaskPassRow[];
  return rows.map(rowToTaskPass);
}

export function getActiveTaskPass(db: Database, taskId: string): TaskPass | null {
  const row = db
    .query("SELECT * FROM task_passes WHERE task_id = ? AND status = 'active' ORDER BY pass_number DESC LIMIT 1")
    .get(taskId) as TaskPassRow | null;
  return row ? rowToTaskPass(row) : null;
}

export function updateTaskPass(
  db: Database,
  passId: string,
  updates: Partial<Omit<TaskPassInput, "id" | "taskId" | "passNumber" | "passType">>,
): void {
  const sets: string[] = ["updated_at = ?"];
  const values: (string | number | null)[] = [new Date().toISOString()];

  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
    if (["completed", "failed", "cancelled"].includes(updates.status)) {
      sets.push("ended_at = ?");
      values.push(new Date().toISOString());
    }
  }
  if (updates.leaseId !== undefined) {
    sets.push("lease_id = ?");
    values.push(updates.leaseId ?? null);
  }
  if (updates.branchName !== undefined) {
    sets.push("branch_name = ?");
    values.push(updates.branchName ?? null);
  }
  if (updates.headCommit !== undefined) {
    sets.push("head_commit = ?");
    values.push(updates.headCommit ?? null);
  }
  if (updates.resultSummary !== undefined) {
    sets.push("result_summary = ?");
    values.push(updates.resultSummary ?? null);
  }
  if (updates.metadata !== undefined) {
    sets.push("metadata = ?");
    values.push(JSON.stringify(updates.metadata));
  }

  values.push(passId);
  db.run(`UPDATE task_passes SET ${sets.join(", ")} WHERE id = ?`, values);
}

export function getNextPassNumber(db: Database, taskId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(pass_number), 0) + 1 AS next FROM task_passes WHERE task_id = ?")
    .get(taskId) as { next: number } | null;
  return row?.next ?? 1;
}

interface TaskPassRow {
  id: string;
  task_id: string;
  pass_number: number;
  pass_type: TaskPassType;
  status: TaskPassStatus;
  started_at: string;
  ended_at: string | null;
  lease_id: string | null;
  branch_name: string | null;
  base_branch: string | null;
  head_commit: string | null;
  base_commit: string | null;
  result_summary: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

function rowToTaskPass(row: TaskPassRow): TaskPass {
  return {
    id: row.id,
    taskId: row.task_id,
    passNumber: row.pass_number,
    passType: row.pass_type,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    leaseId: row.lease_id ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    headCommit: row.head_commit ?? undefined,
    baseCommit: row.base_commit ?? undefined,
    resultSummary: row.result_summary ?? undefined,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================
// Task Leases
// ============================================

export type TaskLeaseStatus = "active" | "released" | "expired" | "revoked";

export interface TaskLease {
  id: string;
  taskId: string;
  passId?: string;
  armId: string;
  status: TaskLeaseStatus;
  claimedAt: string;
  releasedAt?: string;
  releaseReason?: string;
  expiresAt?: string;
  metadata: Record<string, unknown>;
}

export interface TaskLeaseInput {
  id: string;
  taskId: string;
  passId?: string;
  armId: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export function createTaskLease(db: Database, lease: TaskLeaseInput): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO task_leases (
      id, task_id, pass_id, arm_id, status, claimed_at, expires_at, metadata
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      lease.id,
      lease.taskId,
      lease.passId ?? null,
      lease.armId,
      now,
      lease.expiresAt ?? null,
      JSON.stringify(lease.metadata ?? {}),
    ],
  );
}

export function getTaskLease(db: Database, leaseId: string): TaskLease | null {
  const row = db.query("SELECT * FROM task_leases WHERE id = ?").get(leaseId) as TaskLeaseRow | null;
  return row ? rowToTaskLease(row) : null;
}

export function getActiveTaskLease(db: Database, taskId: string): TaskLease | null {
  const row = db
    .query("SELECT * FROM task_leases WHERE task_id = ? AND status = 'active' ORDER BY claimed_at DESC LIMIT 1")
    .get(taskId) as TaskLeaseRow | null;
  return row ? rowToTaskLease(row) : null;
}

export function releaseTaskLease(
  db: Database,
  leaseId: string,
  reason: string,
  status: Extract<TaskLeaseStatus, "released" | "expired" | "revoked"> = "released",
): void {
  db.run(
    `UPDATE task_leases
     SET status = ?, released_at = ?, release_reason = ?
     WHERE id = ?`,
    [status, new Date().toISOString(), reason, leaseId],
  );
}

export function setTaskActiveLease(db: Database, taskId: string, leaseId: string | null): void {
  db.run(
    "UPDATE tasks SET lease_id = ?, updated_at = ? WHERE id = ?",
    [leaseId, new Date().toISOString(), taskId],
  );
}

export function getTaskActiveLeaseId(db: Database, taskId: string): string | null {
  const row = db.query("SELECT lease_id FROM tasks WHERE id = ?").get(taskId) as { lease_id: string | null } | null;
  return row?.lease_id ?? null;
}

export function releaseActiveTaskLease(
  db: Database,
  taskId: string,
  reason: string,
  status: Extract<TaskLeaseStatus, "released" | "expired" | "revoked"> = "released",
): void {
  const lease = getActiveTaskLease(db, taskId);
  if (lease) {
    releaseTaskLease(db, lease.id, reason, status);
  }
  setTaskActiveLease(db, taskId, null);
}

interface TaskLeaseRow {
  id: string;
  task_id: string;
  pass_id: string | null;
  arm_id: string;
  status: TaskLeaseStatus;
  claimed_at: string;
  released_at: string | null;
  release_reason: string | null;
  expires_at: string | null;
  metadata: string;
}

function rowToTaskLease(row: TaskLeaseRow): TaskLease {
  return {
    id: row.id,
    taskId: row.task_id,
    passId: row.pass_id ?? undefined,
    armId: row.arm_id,
    status: row.status,
    claimedAt: row.claimed_at,
    releasedAt: row.released_at ?? undefined,
    releaseReason: row.release_reason ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
  };
}

// ============================================
// Task Decisions
// ============================================

export type TaskDecisionType =
  | "approve"
  | "reject"
  | "request_changes"
  | "request_human"
  | "merge"
  | "skip"
  | "defer";

export type TaskDecisionAuthorType = "arm" | "human" | "brain" | "system";

export interface TaskDecision {
  id: string;
  taskId: string;
  passId?: string;
  decisionType: TaskDecisionType;
  madeBy: string;
  madeByType: TaskDecisionAuthorType;
  reason?: string;
  confidence?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TaskDecisionInput {
  id: string;
  taskId: string;
  passId?: string;
  decisionType: TaskDecisionType;
  madeBy: string;
  madeByType: TaskDecisionAuthorType;
  reason?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export function createTaskDecision(db: Database, decision: TaskDecisionInput): void {
  db.run(
    `INSERT INTO task_decisions (
      id, task_id, pass_id, decision_type, made_by, made_by_type,
      reason, confidence, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      decision.id,
      decision.taskId,
      decision.passId ?? null,
      decision.decisionType,
      decision.madeBy,
      decision.madeByType,
      decision.reason ?? null,
      decision.confidence ?? null,
      JSON.stringify(decision.metadata ?? {}),
      new Date().toISOString(),
    ],
  );
}

export function getTaskDecisions(
  db: Database,
  taskId: string,
  options?: { passId?: string; limit?: number },
): TaskDecision[] {
  let query = "SELECT * FROM task_decisions WHERE task_id = ?";
  const params: (string | number)[] = [taskId];
  if (options?.passId) {
    query += " AND pass_id = ?";
    params.push(options.passId);
  }
  query += " ORDER BY created_at DESC";
  if (options?.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }
  const rows = db.query(query).all(...params) as TaskDecisionRow[];
  return rows.map(rowToTaskDecision);
}

interface TaskDecisionRow {
  id: string;
  task_id: string;
  pass_id: string | null;
  decision_type: TaskDecisionType;
  made_by: string;
  made_by_type: TaskDecisionAuthorType;
  reason: string | null;
  confidence: number | null;
  metadata: string;
  created_at: string;
}

function rowToTaskDecision(row: TaskDecisionRow): TaskDecision {
  return {
    id: row.id,
    taskId: row.task_id,
    passId: row.pass_id ?? undefined,
    decisionType: row.decision_type,
    madeBy: row.made_by,
    madeByType: row.made_by_type,
    reason: row.reason ?? undefined,
    confidence: row.confidence ?? undefined,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

// ============================================
// Task File References
// ============================================

export type TaskFileReferenceType =
  | "acceptance_criteria"
  | "decision"
  | "plan"
  | "source_dependency"
  | "context"
  | "output"
  | "test"
  | "other";

export interface TaskFileReference {
  id: string;
  taskId: string;
  passId?: string;
  filePath: string;
  referenceType: TaskFileReferenceType;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TaskFileReferenceInput {
  id: string;
  taskId: string;
  passId?: string;
  filePath: string;
  referenceType: TaskFileReferenceType;
  metadata?: Record<string, unknown>;
}

export function createTaskFileReference(db: Database, ref: TaskFileReferenceInput): void {
  db.run(
    `INSERT INTO task_file_references (
      id, task_id, pass_id, file_path, reference_type, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ref.id,
      ref.taskId,
      ref.passId ?? null,
      ref.filePath,
      ref.referenceType,
      JSON.stringify(ref.metadata ?? {}),
      new Date().toISOString(),
    ],
  );
}

export function getTaskFileReferences(
  db: Database,
  taskId: string,
  options?: { passId?: string; referenceType?: TaskFileReferenceType },
): TaskFileReference[] {
  let query = "SELECT * FROM task_file_references WHERE task_id = ?";
  const params: (string | number)[] = [taskId];
  if (options?.passId) {
    query += " AND pass_id = ?";
    params.push(options.passId);
  }
  if (options?.referenceType) {
    query += " AND reference_type = ?";
    params.push(options.referenceType);
  }
  query += " ORDER BY created_at DESC";
  const rows = db.query(query).all(...params) as TaskFileReferenceRow[];
  return rows.map(rowToTaskFileReference);
}

interface TaskFileReferenceRow {
  id: string;
  task_id: string;
  pass_id: string | null;
  file_path: string;
  reference_type: TaskFileReferenceType;
  metadata: string;
  created_at: string;
}

function rowToTaskFileReference(row: TaskFileReferenceRow): TaskFileReference {
  return {
    id: row.id,
    taskId: row.task_id,
    passId: row.pass_id ?? undefined,
    filePath: row.file_path,
    referenceType: row.reference_type,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

// ============================================
// Dependency Events
// ============================================

export type DependencyEventType =
  | "blocked"
  | "unblocked"
  | "added"
  | "removed"
  | "plan_update_created";

export interface DependencyEvent {
  id: number;
  taskId: string;
  dependsOnTaskId?: string;
  eventType: DependencyEventType;
  reason?: string;
  createdAt: string;
}

export interface DependencyEventInput {
  taskId: string;
  dependsOnTaskId?: string;
  eventType: DependencyEventType;
  reason?: string;
}

export function recordDependencyEvent(db: Database, event: DependencyEventInput): number {
  const result = db.run(
    `INSERT INTO dependency_events (
      task_id, depends_on_task_id, event_type, reason, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
    [
      event.taskId,
      event.dependsOnTaskId ?? null,
      event.eventType,
      event.reason ?? null,
      new Date().toISOString(),
    ],
  );
  return Number(result.lastInsertRowid);
}

export function getDependencyEvents(
  db: Database,
  taskId: string,
  options?: { dependsOnTaskId?: string; limit?: number },
): DependencyEvent[] {
  let query = "SELECT * FROM dependency_events WHERE task_id = ?";
  const params: (string | number)[] = [taskId];
  if (options?.dependsOnTaskId) {
    query += " AND depends_on_task_id = ?";
    params.push(options.dependsOnTaskId);
  }
  query += " ORDER BY created_at DESC";
  if (options?.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }
  const rows = db.query(query).all(...params) as DependencyEventRow[];
  return rows.map(rowToDependencyEvent);
}

interface DependencyEventRow {
  id: number;
  task_id: string;
  depends_on_task_id: string | null;
  event_type: DependencyEventType;
  reason: string | null;
  created_at: string;
}

function rowToDependencyEvent(row: DependencyEventRow): DependencyEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id ?? undefined,
    eventType: row.event_type,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  };
}
