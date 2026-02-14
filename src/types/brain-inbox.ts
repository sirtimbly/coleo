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
