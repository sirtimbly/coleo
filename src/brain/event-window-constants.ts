/**
 * Event type constants for BrainEventWindow
 * 
 * Extracted from event-window.ts to reduce file size
 */

// Known event types that the analyzer understands
export const KNOWN_EVENT_TYPES = new Set([
	// Session events
	"session.status",
	"session.idle",
	"session.error",
	"session.updated",
	"session.diff",
	"session.compacted",

	// Message events
	"message.updated",
	"message.removed",
	"message.part.updated",
	"message.part.removed",

	// Permission events
	"permission.asked",
	"permission.replied",

	// Todo events
	"todo.updated",

	// File events
	"file.edited",
	"file.read",
	"file.reads",
	"file.watcher.updated",

	// Command events
	"command.executed",

	// Arm lifecycle events
	"arm.spawned",
	"arm.status_changed",
	"status_changed",
	"arm_status_synced",
	"arm.heartbeat",
	"server-heartbeat",
	"server.heartbeat",
	"arm.killed",
	"arm.stopped",

	// Task events
	"task.created",
	"task.assigned",
	"task.claimed",
	"task.completed",
	"task.blocked",
	"task.failed",

	// Brain events
	"arm_prompted",
	"prompt_sent",
	"event-status",
	"event-message-created",
	"event-message-updated",
	"event-part-step-finish",
	"started",
	"stopped",
	"lsp-client-diagnostics",
]);

// Event types that are considered noise and should be filtered out
export const NOISE_EVENT_TYPES = new Set([
	"file.watcher.updated",
	"server.connected",
	"lsp-client-diagnostics",
]);
