import { Hono } from "hono";

import { HttpError } from "../middleware";
import { broadcast } from "../websocket";
import { upsertAttention } from "./workbench-attention";

import type { Database } from "bun:sqlite";
import type {
	CardActionRequest,
	CardActionResult,
	CardJsonObject,
	CardTemplateId,
} from "../../types/adaptive-cards";

interface CardContext {
	Variables: { db: Database };
}

const ACTIONS_BY_TEMPLATE: Record<CardTemplateId, ReadonlySet<string>> = {
	"workbench.event": new Set(["attention.resolve"]),
	"workbench.message": new Set(["message.archive"]),
	"workbench.resource-detail": new Set(),
	"workbench.resource-editor": new Set(["task.update", "bug.update"]),
};

function requireText(input: CardJsonObject, field: string, maxLength: number): string {
	const value = input[field];
	if (typeof value !== "string" || !value.trim()) {
		throw HttpError.badRequest(`${field} is required`);
	}
	if (value.length > maxLength) throw HttpError.badRequest(`${field} is too long`);
	return value.trim();
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
	if (input.template.version !== 1 || !(input.template.id in ACTIONS_BY_TEMPLATE)) {
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

export function createWorkbenchCardRoutes() {
	const app = new Hono<CardContext>();

	app.post("/actions", async (c) => {
		const db = c.get("db");
		const request = validateRequest(await c.req.json<unknown>());
		const allowed = ACTIONS_BY_TEMPLATE[request.template.id];
		if (!allowed.has(request.verb)) {
			throw HttpError.badRequest(
				`Action ${request.verb} is not allowed for ${request.template.id}`,
			);
		}

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
			return c.json({ result: { ...result(request, "Item resolved"), attention } });
		}

		const resource = request.resource;
		if (!resource?.id) throw HttpError.badRequest("A resource is required for this action");

		if (request.verb === "task.update") {
			if (resource.kind !== "task") throw HttpError.badRequest("Expected a task resource");
			const subject = requireText(request.inputs, "title", 500);
			const description = typeof request.inputs.description === "string"
				? request.inputs.description.slice(0, 100_000)
				: "";
			const updatedAt = new Date().toISOString();
			const update = db.run(
				"UPDATE tasks SET subject = ?, description = ?, updated_at = ? WHERE id = ?",
				[subject, description, updatedAt, resource.id],
			);
			if (update.changes === 0) throw HttpError.notFound(`Task not found: ${resource.id}`);
			broadcast("tasks", "task.updated", {
				taskId: resource.id,
				changes: { subject, description },
			});
			return c.json({
				result: result(request, "Task saved", {
					pathname: "/tasks",
					search: `?task=${encodeURIComponent(resource.id)}&view=details`,
					title: subject,
				}),
			});
		}

		if (request.verb === "bug.update") {
			if (resource.kind !== "bug") throw HttpError.badRequest("Expected a bug resource");
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
				result: result(request, "Bug saved", {
					pathname: "/bugs",
					search: `?bug=${encodeURIComponent(resource.id)}`,
					title,
				}),
			});
		}

		throw HttpError.badRequest(`Unsupported card action: ${request.verb}`);
	});

	return app;
}
