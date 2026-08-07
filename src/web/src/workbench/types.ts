/**
 * Shared frontend contracts for durable workbench state.
 *
 * These types keep resource identity, live events, metric samples, view
 * configuration, and Golden Layout persistence independent from any one page.
 */

import type { JsonObject, JsonValue } from "@/lib/api";

export type ResourceKind =
	| "project"
	| "task"
	| "bug"
	| "brain"
	| "arm"
	| "run"
	| "conversation"
	| "message"
	| "document"
	| "plan"
	| "template"
	| "proposal"
	| "discovery";

export interface ResourceRef {
	kind: ResourceKind;
	id: string;
}

export interface WorkbenchEvent {
	id: string;
	sequence?: number;
	timestamp: string;
	type: string;
	actor?: ResourceRef;
	subject?: ResourceRef;
	projectId?: string;
	runId?: string;
	conversationId?: string;
	correlationId?: string;
	causationId?: string;
	severity?: "info" | "success" | "warning" | "danger";
	requiresAttention?: boolean;
	data: JsonObject;
}

export interface MetricSample {
	id?: string | number;
	series: string;
	resource: ResourceRef;
	timestamp: string;
	values: Record<string, number>;
	dimensions?: Record<string, string>;
}

export interface RunRef {
	id: string;
	arm: ResourceRef;
	work: ResourceRef;
	startedAt: string;
	endedAt?: string;
	status: "claimed" | "running" | "blocked" | "completed" | "failed" | "cancelled";
}

export interface ArmRun {
	id: string;
	armId: string;
	armName: string;
	workKind: "task" | "bug";
	workId: string;
	workTitle: string;
	status: RunRef["status"];
	startedAt: string;
	endedAt?: string;
	metadata: JsonObject;
}

export interface PlanDocumentRef extends ResourceRef {
	kind: "plan";
	path: string;
	contentHash?: string;
	reconciliationState?: "clean" | "changed" | "reconciling" | "conflicted";
}

export type ProjectionKind =
	| "sheet"
	| "inbox"
	| "timeline"
	| "conversation"
	| "process"
	| "document"
	| "dashboard"
	| "inspector";

export interface ProjectionFilter {
	field: string;
	operator:
		| "equals"
		| "notEquals"
		| "contains"
		| "in"
		| "notIn"
		| "before"
		| "after"
		| "exists";
	value?: JsonValue;
}

export interface ProjectionSort {
	field: string;
	direction: "asc" | "desc";
}

export interface ColumnPreference {
	id: string;
	visible: boolean;
	order: number;
	width?: number;
}

export interface ViewPreferences {
	columns?: ColumnPreference[];
	filters?: ProjectionFilter[];
	sort?: ProjectionSort[];
	density?: "compact" | "comfortable";
	groupBy?: string[];
	pageSize?: number;
	extras?: JsonObject;
}

export interface ProjectionQuery {
	projectId?: string;
	resourceKinds?: ResourceKind[];
	eventTypes?: string[];
	sources?: ResourceKind[];
	attention?: "all" | "unread" | "unresolved" | "assigned";
	filters?: ProjectionFilter[];
	sort?: ProjectionSort[];
	limit?: number;
}

export interface ViewDefinition {
	id: string;
	profileId: string;
	/** Stable projection key within a profile, independent from import IDs. */
	key: string;
	name: string;
	description?: string;
	kind: ProjectionKind;
	resourceKind?: ResourceKind;
	query: ProjectionQuery;
	preferences: ViewPreferences;
	shared: boolean;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceLayoutRecord {
	id: string;
	profileId: string;
	name: string;
	description?: string;
	layout: JsonObject;
	isDefault: boolean;
	shared: boolean;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface WorkbenchProfile {
	id: string;
	name: string;
	email?: string;
	isDefault: boolean;
	preferences: JsonObject;
	createdAt: string;
	updatedAt: string;
}

export interface WorkbenchBundle {
	schemaVersion: number;
	exportedAt: string;
	profile: WorkbenchProfile;
	views: ViewDefinition[];
	layouts: WorkspaceLayoutRecord[];
}

export type WorkbenchChannel =
	| "arms"
	| "activity"
	| "proposals"
	| "brain"
	| "mail"
	| "tasks"
	| "bugs"
	| "arm-events"
	| "agents"
	| "workbench";

export interface ProjectionSignal {
	channel: WorkbenchChannel;
	event: string;
	timestamp: string;
	data?: JsonValue;
}
