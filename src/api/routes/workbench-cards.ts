import { randomUUID } from "crypto";
import { Hono } from "hono";

import { HttpError } from "../middleware";
import { broadcast } from "../websocket";
import { upsertAttention } from "./workbench-attention";

import type { Database } from "bun:sqlite";
import type {
	CardActionRequest,
	CardActionResult,
	CardEnvelope,
	CardJsonObject,
	CardTemplateId,
} from "../../types/adaptive-cards";

interface CardContext {
	Variables: { db: Database };
}

const ACTIONS_BY_TEMPLATE: Record<CardTemplateId, ReadonlySet<string>> = {
	"workbench.event": new Set([
		"attention.resolve",
		"attention.snooze",
		"attention.assign",
	]),
	"workbench.message": new Set(),
	"workbench.resource-detail": new Set(),
	"workbench.resource-editor": new Set(["task.update", "bug.update"]),
};

const VERSIONS_BY_TEMPLATE: Record<CardTemplateId, ReadonlySet<number>> = {
	"workbench.event": new Set([1]),
	"workbench.message": new Set([1]),
	"workbench.resource-detail": new Set([1, 2]),
	"workbench.resource-editor": new Set([1, 2]),
};

function requireText(input: CardJsonObject, field: string, maxLength: number): string {
	const value = input[field];
	if (typeof value !== "string" || !value.trim()) {
		throw HttpError.badRequest(`${field} is required`);
	}
	if (value.length > maxLength) throw HttpError.badRequest(`${field} is too long`);
	return value.trim();
}

function optionalText(
	input: CardJsonObject,
	field: string,
	maxLength: number,
): string | null | undefined {
	const value = input[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw HttpError.badRequest(`${field} must be text`);
	if (value.length > maxLength) throw HttpError.badRequest(`${field} is too long`);
	return value.trim() || null;
}

function validateRequest(value: unknown): CardActionRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw HttpError.badRequest("Card action must be an object");
	}
	const input = value as Partial<CardActionRequest>;
	if (
		typeof input.envelopeId !== "string" ||
		typeof input.actionId !== "string" ||
		typeof input.verb !== "string" ||
		typeof input.clientActionId !== "string" ||
		!input.template ||
		typeof input.template.id !== "string" ||
		typeof input.template.version !== "number" ||
		!input.inputs ||
		typeof input.inputs !== "object" ||
		Array.isArray(input.inputs)
	) {
		throw HttpError.badRequest("Card action is missing required fields");
	}
	if (
		!(input.template.id in ACTIONS_BY_TEMPLATE) ||
		!VERSIONS_BY_TEMPLATE[input.template.id].has(input.template.version)
	) {
		throw HttpError.badRequest("Unsupported card template version");
	}
	if (JSON.stringify(input.inputs).length > 32_000) {
		throw HttpError.badRequest("Card action input is too large");
	}
	return input as CardActionRequest;
}

function result(
	request: CardActionRequest,
	message: string,
	navigateTo?: CardActionResult["navigateTo"],
): CardActionResult {
	return { ok: true, clientActionId: request.clientActionId, message, navigateTo };
}

function validateEnvelope(value: unknown): CardEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw HttpError.badRequest("Card envelope must be an object");
	}
	const envelope = value as Partial<CardEnvelope>;
	if (
		typeof envelope.id !== "string" ||
		envelope.schemaVersion !== "1.5" ||
		!envelope.template ||
		typeof envelope.template.id !== "string" ||
		typeof envelope.template.version !== "number" ||
		!(envelope.template.id in ACTIONS_BY_TEMPLATE) ||
		!VERSIONS_BY_TEMPLATE[envelope.template.id].has(envelope.template.version) ||
		!envelope.presentation ||
		typeof envelope.presentation.surface !== "string" ||
		!envelope.data ||
		typeof envelope.data !== "object" ||
		Array.isArray(envelope.data)
	) {
		throw HttpError.badRequest("Unsupported card envelope");
	}
	if (JSON.stringify(envelope).length > 64_000) {
		throw HttpError.badRequest("Card envelope is too large");
	}
	return envelope as CardEnvelope;
}

function getActionReceipt(db: Database, clientActionId: string): CardActionResult | null {
	const row = db.query(
		"SELECT result FROM workbench_card_action_receipts WHERE client_action_id = ?",
	).get(clientActionId) as { result: string } | null;
	if (!row) return null;
	try {
		return JSON.parse(row.result) as CardActionResult;
	} catch {
		return null;
	}
}

function beginActionAudit(db: Database, request: CardActionRequest): number {
	const createdAt = new Date().toISOString();
	const receipt = db.run(
		`INSERT INTO workbench_card_action_audit (
		   client_action_id, envelope_id, template_id, template_version,
		   resource_kind, resource_id, verb, input_keys, outcome, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'attempted', ?)`,
		[
			request.clientActionId,
			request.envelopeId,
			request.template.id,
			request.template.version,
			request.resource?.kind ?? null,
			request.resource?.id ?? null,
			request.verb,
			JSON.stringify(Object.keys(request.inputs).sort()),
			createdAt,
		],
	);
	return Number(receipt.lastInsertRowid);
}

function completeAction(
	db: Database,
	auditId: number,
	request: CardActionRequest,
	actionResult: CardActionResult,
): CardActionResult {
	db.transaction(() => {
		db.run(
			`INSERT INTO workbench_card_action_receipts (
			   client_action_id, envelope_id, template_id, template_version,
			   resource_kind, resource_id, verb, result, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				request.clientActionId,
				request.envelopeId,
				request.template.id,
				request.template.version,
				request.resource?.kind ?? null,
				request.resource?.id ?? null,
				request.verb,
				JSON.stringify(actionResult),
				new Date().toISOString(),
			],
		);
		db.run(
			"UPDATE workbench_card_action_audit SET outcome = 'succeeded' WHERE id = ?",
			[auditId],
		);
	})();
	return actionResult;
}

function requireCurrentVersion(
	db: Database,
	table: "tasks" | "bugs",
	id: string,
	expected: string | undefined,
): void {
	const row = db.query(`SELECT updated_at AS updatedAt FROM ${table} WHERE id = ?`).get(id) as
		| { updatedAt: string }
		| null;
	if (!row) throw HttpError.notFound(`${table === "tasks" ? "Task" : "Bug"} not found: ${id}`);
	if (expected && row.updatedAt !== expected) {
		throw new HttpError(409, "This resource changed after the card was opened. Refresh and try again.");
	}
}

export function createWorkbenchCardRoutes() {
	const app = new Hono<CardContext>();

	app.post("/instances", async (c) => {
		const db = c.get("db");
		const body = await c.req.json<{ envelope?: unknown; profileId?: unknown }>();
		const envelope = validateEnvelope(body.envelope);
		const profileId = typeof body.profileId === "string" ? body.profileId : "local";
		if (!db.query("SELECT id FROM workbench_profiles WHERE id = ?").get(profileId)) {
			throw HttpError.notFound(`Workbench profile not found: ${profileId}`);
		}
		const id = randomUUID();
		const now = new Date().toISOString();
		const expiresAt = envelope.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
		db.run(
			`INSERT INTO workbench_card_instances (
			   id, profile_id, template_id, template_version, resource_kind,
			   resource_id, envelope, created_at, updated_at, expires_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				profileId,
				envelope.template.id,
				envelope.template.version,
				envelope.resource?.kind ?? null,
				envelope.resource?.id ?? null,
				JSON.stringify(envelope),
				now,
				now,
				expiresAt,
			],
		);
		return c.json({ instance: { id, envelope, createdAt: now, expiresAt } }, 201);
	});

	app.get("/instances/:id", (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const row = db.query(
			`SELECT envelope, created_at AS createdAt, expires_at AS expiresAt
			 FROM workbench_card_instances WHERE id = ?`,
		).get(id) as { envelope: string; createdAt: string; expiresAt: string | null } | null;
		if (!row || (row.expiresAt && Date.parse(row.expiresAt) < Date.now())) {
			throw HttpError.notFound(`Card instance not found: ${id}`);
		}
		return c.json({
			instance: {
				id,
				envelope: validateEnvelope(JSON.parse(row.envelope) as unknown),
				createdAt: row.createdAt,
				expiresAt: row.expiresAt ?? undefined,
			},
		});
	});

	app.post("/actions", async (c) => {
		const db = c.get("db");
		const request = validateRequest(await c.req.json<unknown>());
		const allowed = ACTIONS_BY_TEMPLATE[request.template.id];
		if (!allowed.has(request.verb)) {
			throw HttpError.badRequest(
				`Action ${request.verb} is not allowed for ${request.template.id}`,
			);
		}
		const existingResult = getActionReceipt(db, request.clientActionId);
		if (existingResult) return c.json({ result: existingResult });
		const auditId = beginActionAudit(db, request);

		if (request.verb === "attention.resolve") {
			const attention = upsertAttention(db, {
				profileId: "local",
				itemKey: request.envelopeId,
				patch: {
					readAt: new Date().toISOString(),
					resolvedAt: new Date().toISOString(),
					requiresAction: false,
				},
			});
			broadcast("workbench", "workbench.attention.updated", {
				profileId: "local",
				itemKey: request.envelopeId,
			});
			return c.json({
				result: {
					...completeAction(db, auditId, request, result(request, "Item resolved")),
					attention,
				},
			});
		}

		if (request.verb === "attention.snooze") {
			const duration = typeof request.inputs.durationMinutes === "number"
				? Math.min(Math.max(request.inputs.durationMinutes, 5), 7 * 24 * 60)
				: 60;
			const snoozedUntil = new Date(Date.now() + duration * 60_000).toISOString();
			upsertAttention(db, {
				profileId: "local",
				itemKey: request.envelopeId,
				patch: { readAt: new Date().toISOString(), snoozedUntil },
			});
			broadcast("workbench", "workbench.attention.updated", {
				profileId: "local",
				itemKey: request.envelopeId,
			});
			return c.json({
				result: completeAction(
					db,
					auditId,
					request,
					result(request, `Snoozed until ${snoozedUntil}`),
				),
			});
		}

		if (request.verb === "attention.assign") {
			upsertAttention(db, {
				profileId: "local",
				itemKey: request.envelopeId,
				patch: { assignedTo: "local", seenAt: new Date().toISOString() },
			});
			broadcast("workbench", "workbench.attention.updated", {
				profileId: "local",
				itemKey: request.envelopeId,
			});
			return c.json({
				result: completeAction(db, auditId, request, result(request, "Assigned to local profile")),
			});
		}

		const resource = request.resource;
		if (!resource?.id) throw HttpError.badRequest("A resource is required for this action");

		if (request.verb === "task.update") {
			if (resource.kind !== "task") throw HttpError.badRequest("Expected a task resource");
			requireCurrentVersion(db, "tasks", resource.id, request.expectedResourceVersion);
			const subject = requireText(request.inputs, "title", 500);
			const description = typeof request.inputs.description === "string"
				? request.inputs.description.slice(0, 100_000)
				: "";
			const priorityInput = request.inputs.priority;
			const priority = priorityInput === undefined
				? undefined
				: typeof priorityInput === "string" &&
					["critical", "high", "normal", "low"].includes(priorityInput)
					? priorityInput
					: null;
			if (priorityInput !== undefined && priority === null) {
				throw HttpError.badRequest("priority is invalid");
			}
			const dueDateInput = request.inputs.dueDate;
			let dueDate: string | null | undefined;
			if (dueDateInput !== undefined) {
				if (typeof dueDateInput !== "string") throw HttpError.badRequest("dueDate must be a date");
				dueDate = dueDateInput.trim() || null;
				if (
					dueDate &&
					(!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
						Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)))
				) {
					throw HttpError.badRequest("dueDate must use YYYY-MM-DD");
				}
			}
			const progressInput = request.inputs.progress;
			let progress: number | undefined;
			if (progressInput !== undefined && progressInput !== "") {
				progress = typeof progressInput === "number"
					? progressInput
					: typeof progressInput === "string"
						? Number(progressInput)
						: Number.NaN;
				if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
					throw HttpError.badRequest("progress must be between 0 and 100");
				}
			}
			const phase = optionalText(request.inputs, "phase", 200);
			const domain = optionalText(request.inputs, "domain", 200);
			const updatedAt = new Date().toISOString();
			const columns = ["subject = ?", "description = ?"];
			const values: Array<string | number | null> = [subject, description];
			const changes: Record<string, string | number | null> = { subject, description };
			if (priority !== undefined) {
				columns.push("priority = ?");
				values.push(priority);
				changes.priority = priority;
			}
			if (dueDate !== undefined) {
				columns.push("due_date = ?");
				values.push(dueDate);
				changes.dueDate = dueDate;
			}
			if (progress !== undefined) {
				columns.push("progress = ?");
				values.push(progress);
				changes.progress = progress;
			}
			if (phase !== undefined) {
				columns.push("phase = ?");
				values.push(phase);
				changes.phase = phase;
			}
			if (domain !== undefined) {
				columns.push("domain = ?");
				values.push(domain);
				changes.domain = domain;
			}
			columns.push("updated_at = ?");
			values.push(updatedAt, resource.id);
			const update = db.run(
				`UPDATE tasks SET ${columns.join(", ")} WHERE id = ?`,
				values,
			);
			if (update.changes === 0) throw HttpError.notFound(`Task not found: ${resource.id}`);
			broadcast("tasks", "task.updated", {
				taskId: resource.id,
				changes,
			});
			return c.json({
				result: completeAction(db, auditId, request, result(request, "Task saved", {
					pathname: "/tasks",
					search: `?task=${encodeURIComponent(resource.id)}&view=details`,
					title: subject,
				})),
			});
		}

		if (request.verb === "bug.update") {
			if (resource.kind !== "bug") throw HttpError.badRequest("Expected a bug resource");
			requireCurrentVersion(db, "bugs", resource.id, request.expectedResourceVersion);
			const title = requireText(request.inputs, "title", 500);
			const description = typeof request.inputs.description === "string"
				? request.inputs.description.slice(0, 100_000)
				: "";
			const updatedAt = new Date().toISOString();
			const update = db.run(
				"UPDATE bugs SET title = ?, description = ?, updated_at = ? WHERE id = ?",
				[title, description, updatedAt, resource.id],
			);
			if (update.changes === 0) throw HttpError.notFound(`Bug not found: ${resource.id}`);
			broadcast("bugs", "bug.updated", {
				bugId: resource.id,
				changes: { title, description },
			});
			return c.json({
				result: completeAction(db, auditId, request, result(request, "Bug saved", {
					pathname: "/bugs",
					search: `?bug=${encodeURIComponent(resource.id)}`,
					title,
				})),
			});
		}

		throw HttpError.badRequest(`Unsupported card action: ${request.verb}`);
	});

	return app;
}
