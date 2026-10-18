import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { formatErrorResponse } from "../middleware/error";
import { createWorkbenchNamedViewRoutes } from "../routes/workbench-named-views";

import type { ResolvedNamedResourceView } from "../../workbench/named-resource-views";

function app(): Hono {
	const app = new Hono();
	app.onError((error, c) => formatErrorResponse(c, error));
	app.route("/named-views", createWorkbenchNamedViewRoutes());
	return app;
}

describe("named resource-view API", () => {
	it("lists and resolves reusable definitions independently of persisted panel preferences", async () => {
		const api = app();
		expect(await (await api.request("/named-views")).json()).toEqual({ schemaVersion: 1, views: ["inbox-triage"] });
		const responses = await Promise.all(["web", "cli", "tui"].map((client) => api.request(`/named-views/inbox-triage?client=${client}`)));
		for (const response of responses) expect(response.status).toBe(200);
		const [web, cli, tui] = await Promise.all(responses.map((response) => response.json() as Promise<ResolvedNamedResourceView>));
		expect(cli!.definition).toEqual(web!.definition);
		expect(tui!.queryIdentity).toBe(web!.queryIdentity);
		expect(web!.definition.slots["toolbar.secondary.sort"]?.[0]?.binding).toBe("query.sort");
		expect(cli!.interactions.bindings.find((binding) => binding.id === "search")?.cli).toEqual({ flag: "--search", alias: "-s" });
	});

	it("validates local definitions without replacing the active builtin and gives actionable conflicts", async () => {
		const api = app();
		const original = await (await api.request("/named-views/inbox-triage")).json() as ResolvedNamedResourceView;
		const changed = { ...original.definition, query: { ...original.definition.query, search: "review", limit: 3 } };
		const valid = await api.request("/named-views/resolve", { method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client: "cli", definition: changed }) });
		expect(valid.status).toBe(200);
		expect((await valid.json() as ResolvedNamedResourceView).definition.query).toMatchObject({ search: "review", limit: 3 });
		for (const definition of [
			{ ...changed, schemaVersion: 2 },
			{ ...changed, interactions: [{ id: "search", operation: "collection.search", keyboard: { shared: [{ key: "p", modifiers: ["meta"] }] } }] },
			{ ...changed, interactions: [{ id: "bad", operation: "collection.search", cli: { flag: "--search" } }] },
		]) {
			const response = await api.request("/named-views/resolve", { method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ client: "web", definition }) });
			expect(response.status).toBe(400);
			expect((await response.json() as { error: string }).error.length).toBeGreaterThan(0);
		}
		expect(await (await api.request("/named-views/inbox-triage")).json()).toEqual(original);
	});

	it("rejects unknown view names, clients, and malformed input", async () => {
		const api = app();
		expect((await api.request("/named-views/missing")).status).toBe(404);
		expect((await api.request("/named-views/constructor")).status).toBe(404);
		expect((await api.request("/named-views/inbox-triage?client=browser-ish")).status).toBe(400);
		expect((await api.request("/named-views/resolve", { method: "POST", body: "{" })).status).toBe(400);
	});
});
