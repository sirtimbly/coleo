import type { MessageType } from "./index";

export const BRAIN_INBOX_MESSAGE_TYPES = [
	"task_assignment",
	"task_complete",
	"task_validation",
	"task_acknowledge",
	"task_validate",
	"discovery",
	"dependency_discovery",
	"approval_request",
	"share_note",
	"tool_discovery",
	"status_update",
	"heartbeat",
	"doc_update",
	"file_subscription",
	"file_change",
	"status_report",
	"bug_report",
	"bug_claim",
] as const satisfies readonly MessageType[];

export type BrainInboxMessageType = (typeof BRAIN_INBOX_MESSAGE_TYPES)[number];

const BRAIN_INBOX_MESSAGE_TYPE_SET = new Set<string>(BRAIN_INBOX_MESSAGE_TYPES);

export function isBrainInboxMessageType(value: string): value is BrainInboxMessageType {
	return BRAIN_INBOX_MESSAGE_TYPE_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasString(value: Record<string, unknown>, key: string): boolean {
	return typeof value[key] === "string" && (value[key] as string).trim().length > 0;
}

function hasBoolean(value: Record<string, unknown>, key: string): boolean {
	return typeof value[key] === "boolean";
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || typeof value[key] === "string";
}

function hasOptionalStringArray(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || isStringArray(value[key]);
}

export function validateBrainInboxPayload(type: BrainInboxMessageType, payload: unknown): string | null {
	if (!isRecord(payload)) {
		return "payload must be an object";
	}

	switch (type) {
		case "task_assignment":
			if (!hasString(payload, "taskId")) return "task_assignment requires payload.taskId";
			if (!hasString(payload, "action")) return "task_assignment requires payload.action";
			return null;
		case "task_complete":
			if (!hasString(payload, "taskId")) return "task_complete requires payload.taskId";
			if (!hasString(payload, "summary")) return "task_complete requires payload.summary";
			if (!hasOptionalStringArray(payload, "artifacts")) return "task_complete payload.artifacts must be string[]";
			return null;
		case "task_validation":
		case "task_validate":
			if (!hasString(payload, "taskId")) return `${type} requires payload.taskId`;
			if (!hasBoolean(payload, "approved")) return `${type} requires payload.approved`;
			if (!hasString(payload, "notes")) return `${type} requires payload.notes`;
			return null;
		case "task_acknowledge":
			if (!hasString(payload, "taskId")) return "task_acknowledge requires payload.taskId";
			return null;
		case "discovery":
			if (!hasString(payload, "title")) return "discovery requires payload.title";
			if (!hasString(payload, "details")) return "discovery requires payload.details";
			return null;
		case "dependency_discovery":
			if (!hasString(payload, "taskId")) return "dependency_discovery requires payload.taskId";
			if (!hasString(payload, "dependsOn")) return "dependency_discovery requires payload.dependsOn";
			if (!hasString(payload, "type")) return "dependency_discovery requires payload.type";
			if (!hasString(payload, "description")) return "dependency_discovery requires payload.description";
			return null;
		case "approval_request":
			if (!hasString(payload, "action")) return "approval_request requires payload.action";
			if (!hasString(payload, "context")) return "approval_request requires payload.context";
			if (!hasOptionalStringArray(payload, "options")) return "approval_request payload.options must be string[]";
			return null;
		case "share_note":
			if (!hasString(payload, "title")) return "share_note requires payload.title";
			if (!hasString(payload, "content")) return "share_note requires payload.content";
			if (!hasOptionalStringArray(payload, "tags")) return "share_note payload.tags must be string[]";
			return null;
		case "tool_discovery":
			if (!hasString(payload, "name")) return "tool_discovery requires payload.name";
			if (!hasString(payload, "command")) return "tool_discovery requires payload.command";
			if (!hasString(payload, "description")) return "tool_discovery requires payload.description";
			return null;
		case "status_update":
			if (!hasString(payload, "taskId")) return "status_update requires payload.taskId";
			if (!hasString(payload, "status")) return "status_update requires payload.status";
			if (!hasOptionalString(payload, "message")) return "status_update payload.message must be a string";
			return null;
		case "heartbeat":
			if (!hasString(payload, "timestamp")) return "heartbeat requires payload.timestamp";
			if (Number.isNaN(new Date(payload.timestamp as string).getTime())) {
				return "heartbeat payload.timestamp must be an ISO date string";
			}
			return null;
		case "doc_update":
			if (!hasString(payload, "path")) return "doc_update requires payload.path";
			if (!hasString(payload, "reason")) return "doc_update requires payload.reason";
			return null;
		case "file_subscription":
			if (!hasString(payload, "action")) return "file_subscription requires payload.action";
			if (!hasString(payload, "pattern")) return "file_subscription requires payload.pattern";
			return null;
		case "file_change":
			if (!hasString(payload, "filePath")) return "file_change requires payload.filePath";
			if (!hasString(payload, "changeType")) return "file_change requires payload.changeType";
			if (!hasString(payload, "summary")) return "file_change requires payload.summary";
			return null;
		case "status_report":
			if (!hasString(payload, "id")) return "status_report requires payload.id";
			if (!hasString(payload, "taskId")) return "status_report requires payload.taskId";
			if (!hasString(payload, "armId")) return "status_report requires payload.armId";
			if (!hasString(payload, "status")) return "status_report requires payload.status";
			if (!hasString(payload, "summary")) return "status_report requires payload.summary";
			if (!hasOptionalStringArray(payload, "issues")) return "status_report payload.issues must be string[]";
			if (!hasOptionalStringArray(payload, "blockers")) return "status_report payload.blockers must be string[]";
			return null;
		case "bug_report":
			if (!hasString(payload, "id")) return "bug_report requires payload.id";
			if (!hasString(payload, "title")) return "bug_report requires payload.title";
			if (!hasString(payload, "description")) return "bug_report requires payload.description";
			if (!hasString(payload, "source")) return "bug_report requires payload.source";
			return null;
		case "bug_claim":
			if (!hasString(payload, "bugId")) return "bug_claim requires payload.bugId";
			if (!hasString(payload, "action")) return "bug_claim requires payload.action";
			return null;
		default:
			return null;
	}
}
