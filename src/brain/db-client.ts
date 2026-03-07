import type { Task } from "../types";

/**
 * Brain-side DB contracts.
 *
 * Brain code should use semantic API methods only.
 * SQLite/SQL access belongs in the API server layer.
 */

export interface BrainTaskRecord {
  id: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  sourceType: string;
  sourceRef: string | null;
  phase: string | null;
  domain: string | null;
  classification: string | null;
  assignedTo: string | null;
  dependencyBlocked: boolean;
  consensusStatus: string | null;
  sortOrder: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  context?: Task["context"];
}

export interface BrainTaskListFilters {
  statuses?: string[];
  excludeStatuses?: string[];
  priority?: string;
  domain?: string;
  phase?: string;
  assignedTo?: string | null;
  unassignedOnly?: boolean;
  dependencyBlocked?: boolean;
  includeSubject?: string;
  excludeSubjectPrefix?: string;
  limit?: number;
  offset?: number;
  sort?:
    | "created_desc"
    | "created_asc"
    | "updated_desc"
    | "completed_desc"
    | "priority_then_created_asc"
    | "sort_order_asc";
}

export interface BrainTaskCreateInput {
  id?: string;
  subject: string;
  description: string;
  status?: string;
  priority?: string;
  sourceType?: string;
  sourceRef?: string | null;
  phase?: string | null;
  domain?: string | null;
  classification?: string | null;
  assignedTo?: string | null;
  dependencyBlocked?: boolean;
  sortOrder?: number | null;
  context?: Task["context"];
}

export interface BrainTaskPatchInput {
  subject?: string;
  description?: string;
  status?: string;
  priority?: string;
  phase?: string | null;
  domain?: string | null;
  classification?: string | null;
  assignedTo?: string | null;
  dependencyBlocked?: boolean;
  sortOrder?: number | null;
  context?: Task["context"];
}

export interface BrainBugRecord {
  id: string;
  title: string;
  description: string;
  source: string;
  status: string;
  priority: string;
  assigneeArmId: string | null;
  errorDetails: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrainBugListFilters {
  statuses?: string[];
  priority?: string;
  assigneeArmId?: string | null;
  unassignedOnly?: boolean;
  includeTitle?: string;
  limit?: number;
}

export interface BrainDiscoveryRecord {
  id: string;
  armId: string;
  armName: string;
  kind: string;
  title: string;
  details: string;
  filePath: string | null;
  lineNumber: number | null;
  severity: string;
  status: string;
  taskId?: string | null;
  phase?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrainDiscoveryListFilters {
  armId?: string;
  kind?: string;
  severities?: string[];
  status?: string;
  taskId?: string;
  limit?: number;
}

export interface BrainStatusReportRecord {
  id: string;
  taskId: string;
  armId: string;
  status: string;
  summary: string;
  issues: string[];
  blockers: string[];
  nextSteps?: string;
  filesChanged: string[];
  testsStatus?: "passing" | "failing" | "not_run";
  createdAt: string;
}

export interface BrainStatusReportListFilters {
  taskId?: string;
  armId?: string;
  status?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface BrainTaskDependencyRecord {
  taskId: string;
  dependsOnTaskId: string;
  dependencyType:
    | "finish_to_start"
    | "start_to_start"
    | "finish_to_finish"
    | "start_to_finish";
  autoDetected: boolean;
  reason: string | null;
}

export interface BrainTaskDependencyUpsertInput {
  taskId: string;
  dependsOnTaskId: string;
  dependencyType?:
    | "finish_to_start"
    | "start_to_start"
    | "finish_to_finish"
    | "start_to_finish";
  autoDetected?: boolean;
  reason?: string | null;
}

export interface BrainArmRecord {
  id: string;
  name: string;
  status: string;
  currentTaskSubject: string | null;
  lastActivityAt: string | null;
}

export interface BrainArmListFilters {
  armId?: string;
  includeStopped?: boolean;
}

export interface BrainDb {
  listTasks: (filters?: BrainTaskListFilters) => BrainTaskRecord[];
  getTask: (taskId: string) => BrainTaskRecord | null;
  createTask: (input: BrainTaskCreateInput) => BrainTaskRecord;
  updateTask: (taskId: string, patch: BrainTaskPatchInput) => BrainTaskRecord;
  listBugs: (filters?: BrainBugListFilters) => BrainBugRecord[];
  getBug: (bugId: string) => BrainBugRecord | null;
  listDiscoveries: (filters?: BrainDiscoveryListFilters) => BrainDiscoveryRecord[];
  listStatusReports: (
    filters?: BrainStatusReportListFilters,
  ) => BrainStatusReportRecord[];
  listTaskDependencies: (taskId: string) => BrainTaskDependencyRecord[];
  upsertTaskDependency: (input: BrainTaskDependencyUpsertInput) => void;
  listArms: (filters?: BrainArmListFilters) => BrainArmRecord[];
}

export interface ArmStateRecord {
  arm_id: string;
  state: string;
  previous_state: string | null;
  current_task_id: string | null;
  current_task_subject: string | null;
  last_event_type: string | null;
  last_event_at: string;
  state_entered_at: string;
  task_assigned_at: string | null;
  disconnected_at: string | null;
  last_error: string | null;
  error_count: number;
  last_heartbeat: string | null;
  consecutive_missed_heartbeats: number;
}

export interface ArmStateUpsertInput {
  state?: string;
  previousState?: string | null;
  currentTaskId?: string | null;
  currentTaskSubject?: string | null;
  lastEventType?: string | null;
  lastEventAt?: string;
  stateEnteredAt?: string;
  taskAssignedAt?: string | null;
  disconnectedAt?: string | null;
  lastError?: string | null;
  errorCount?: number;
  lastHeartbeat?: string | null;
  consecutiveMissedHeartbeats?: number;
}

export interface ArmStateStore {
  getArmState: (armId: string) => ArmStateRecord | null;
  listArmStatesByState: (state: string) => ArmStateRecord[];
  upsertArmState: (armId: string, input: ArmStateUpsertInput) => void;
  deleteArmState: (armId: string) => void;
  transaction?: <T>(fn: () => T) => () => T;
  close?: () => void;
}
