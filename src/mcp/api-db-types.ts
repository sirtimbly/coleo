import type { Task } from "../types";

export interface McpDbRunResult {
	changes: number;
	lastInsertRowid: number | null;
}

export interface McpDbQueryHandle {
	get: (...params: unknown[]) => unknown;
	all: (...params: unknown[]) => unknown[];
}

export interface McpDb {
	run: (sql: string, ...bindings: unknown[]) => McpDbRunResult;
	query: (sql: string) => McpDbQueryHandle;
	transaction?: <T>(fn: () => T) => () => T;
	close?: () => void;
}

export interface ApiTask {
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
	consensusStatus?: string;
	sortOrder?: number | null;
	orderKey?: string | null;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	context?: Task["context"];
}

export interface ApiBug {
	id: string;
	title: string;
	description: string;
	source: string;
	status: string;
	priority: string;
	assigneeArmId?: string;
	errorDetails?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ApiDiscovery {
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

export interface ApiStatusReport {
	id: string;
	taskId: string;
	armId: string;
	status: string;
	summary: string;
	issues?: string[];
	blockers?: string[];
	nextSteps?: string;
	filesChanged?: string[];
	testsStatus?: "passing" | "failing" | "not_run";
	createdAt: string;
}

export interface ApiArm {
	id: string;
	name: string;
	status: string;
	currentTaskSubject?: string;
	lastActivityAt?: string;
}

export interface CurlResult {
	statusCode: number;
	body: string;
}
