import { Hono } from "hono";
import { z } from "zod";

import { INTERACTION_CLIENTS } from "../../workbench/interaction-definition";
import { getNamedResourceView, NAMED_RESOURCE_VIEWS, resolveNamedResourceView } from "../../workbench/named-resource-views";
import { HttpError } from "../middleware/error";

const resolveRequest = z.object({ client: z.enum(INTERACTION_CLIENTS), definition: z.unknown() }).strict();

/** Reusable definitions are distinct from persisted /views panel preferences. */
export function createWorkbenchNamedViewRoutes(): Hono {
	const app = new Hono();
	app.get("/", (c) => c.json({ schemaVersion: 1, views: Object.keys(NAMED_RESOURCE_VIEWS) }));
	app.post("/resolve", async (c) => {
		try {
			const body = resolveRequest.parse(await c.req.json());
			return c.json(resolveNamedResourceView(body.definition, body.client));
		} catch (error) {
			throw HttpError.badRequest(error instanceof Error ? error.message : "Invalid resource view definition");
		}
	});
	app.get("/:id", (c) => {
		const client = z.enum(INTERACTION_CLIENTS).safeParse(c.req.query("client") ?? "web");
		if (!client.success) throw HttpError.badRequest("client must be web, cli, or tui");
		const view = getNamedResourceView(c.req.param("id"), client.data);
		if (!view) throw HttpError.notFound(`Named resource view not found: ${c.req.param("id")}`);
		return c.json(view);
	});
	return app;
}
