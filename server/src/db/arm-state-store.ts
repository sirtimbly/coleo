import type { Database } from "bun:sqlite";

import type {
	ArmStateRecord,
	ArmStateStore,
	ArmStateUpsertInput,
} from "../brain/db-client";

export function createSqliteArmStateStore(db: Database): ArmStateStore {
	return {
		getArmState(armId: string): ArmStateRecord | null {
			const row = db
				.query(
					`SELECT arm_id, state, previous_state, current_task_id, current_task_subject, last_event_type,
                last_event_at, state_entered_at, task_assigned_at, disconnected_at, last_error,
                error_count, last_heartbeat, consecutive_missed_heartbeats
         FROM arm_state_machine WHERE arm_id = ?`,
				)
				.get(armId) as ArmStateRecord | null;
			return row;
		},
		listArmStatesByState(state: string): ArmStateRecord[] {
			return db
				.query(
					`SELECT arm_id, state, previous_state, current_task_id, current_task_subject, last_event_type,
                last_event_at, state_entered_at, task_assigned_at, disconnected_at, last_error,
                error_count, last_heartbeat, consecutive_missed_heartbeats
         FROM arm_state_machine WHERE state = ?`,
				)
				.all(state) as ArmStateRecord[];
		},
		upsertArmState(armId: string, input: ArmStateUpsertInput): void {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO arm_state_machine (
           arm_id, state, previous_state, current_task_id, current_task_subject, last_event_type,
           last_event_at, state_entered_at, task_assigned_at, disconnected_at, last_error,
           error_count, last_heartbeat, consecutive_missed_heartbeats
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(arm_id) DO UPDATE SET
           state = excluded.state,
           previous_state = excluded.previous_state,
           current_task_id = excluded.current_task_id,
           current_task_subject = excluded.current_task_subject,
           last_event_type = excluded.last_event_type,
           last_event_at = excluded.last_event_at,
           state_entered_at = excluded.state_entered_at,
           task_assigned_at = excluded.task_assigned_at,
           disconnected_at = excluded.disconnected_at,
           last_error = excluded.last_error,
           error_count = excluded.error_count,
           last_heartbeat = excluded.last_heartbeat,
           consecutive_missed_heartbeats = excluded.consecutive_missed_heartbeats`,
				[
					armId,
					input.state || "spawning",
					input.previousState ?? null,
					input.currentTaskId ?? null,
					input.currentTaskSubject ?? null,
					input.lastEventType ?? null,
					input.lastEventAt || now,
					input.stateEnteredAt || now,
					input.taskAssignedAt ?? null,
					input.disconnectedAt ?? null,
					input.lastError ?? null,
					input.errorCount ?? 0,
					input.lastHeartbeat ?? null,
					input.consecutiveMissedHeartbeats ?? 0,
				],
			);
		},
		deleteArmState(armId: string): void {
			db.run("DELETE FROM arm_state_machine WHERE arm_id = ?", [armId]);
		},
		transaction<T>(fn: () => T): () => T {
			return () => fn();
		},
	};
}
