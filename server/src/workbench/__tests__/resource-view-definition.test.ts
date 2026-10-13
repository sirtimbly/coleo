import { describe, expect, it } from "bun:test";

import { INBOX_TRIAGE_REGISTRY } from "../examples/inbox-triage-registry";
import { parseResourceViewDefinition, resolveResourceViewFeatures } from "../resource-view-definition";

import type { ResourceViewRegistry } from "../resource-view-definition";

const fixture = await Bun.file(new URL("../examples/inbox-triage.json", import.meta.url)).json();
const registry: ResourceViewRegistry = INBOX_TRIAGE_REGISTRY;

describe("named resource-view composition", () => {
	it("round-trips both toolbar tiers, optional metadata, and grid/cards/custom presentations without UI imports", () => {
		const view = parseResourceViewDefinition(fixture, registry);
		expect(parseResourceViewDefinition(JSON.parse(JSON.stringify(view)), registry)).toEqual(view);
		expect(view.slots["toolbar.primary.search"]?.[0]?.binding).toBe("query.search");
		expect(view.slots["toolbar.secondary.insights"]?.[0]?.binding).toBe("insights.active");
		expect(view.insights?.active).toBeNull();
		expect(view.presentation.renderers.map((renderer) => renderer.kind)).toEqual(["grid", "cards", "custom"]);
	});

	it("keeps the same query, fields, and commands while adapting presentation and metadata to a terminal", () => {
		const view = parseResourceViewDefinition(fixture, registry);
		const snapshot = JSON.stringify(view);
		const web = resolveResourceViewFeatures(view, registry, new Set(["table", "adaptive-cards", "timeline", "charts"]));
		const terminal = resolveResourceViewFeatures(view, registry, new Set(["table", "text"]));
		expect(web.presentation.map((feature) => feature.implementation))
			.toEqual(["collection.grid", "collection.cards", "messaging.timeline"]);
		expect(terminal.presentation.map((feature) => feature.implementation))
			.toEqual(["collection.grid", "collection.list", "collection.list"]);
		expect(terminal.insights[0]).toMatchObject({ id: "overview", implementation: "metadata.summary" });
		expect(terminal.slots["toolbar.primary.actions"]?.every((control) => control.implementation !== null)).toBe(true);
		expect(terminal.presentation[1]?.diagnostic).toContain("instead of collection.cards");
		expect(JSON.stringify(view)).toBe(snapshot);
	});

	it("gives unsupported features and cyclic fallbacks explicit diagnostics", () => {
		const view = parseResourceViewDefinition(fixture, registry);
		const unsupported = resolveResourceViewFeatures(view, registry, new Set());
		expect(unsupported.presentation[0]).toMatchObject({ implementation: null, diagnostic: "Requires capabilities: table" });
		const cyclic = { ...registry, renderers: { ...registry.renderers,
			"collection.list": { kinds: ["custom"] as const, capabilities: ["text"], fallback: "collection.cards" },
		} };
		expect(resolveResourceViewFeatures(view, cyclic, new Set()).presentation[1]?.diagnostic).toContain("Fallback cycle");
	});

	it("rejects invalid bindings, wrong hierarchy slots, duplicate IDs, fields, commands, and future schema versions", () => {
		const view = parseResourceViewDefinition(fixture, registry);
		for (const invalid of [
			{ ...view, schemaVersion: 2 }, { ...view, commands: [...view.commands, "execute-javascript"] },
			{ ...view, slots: { "toolbar.primary.search": [{ id: "bad", widget: "collection.search", label: "Bad", binding: "query.missing" }] } },
			{ ...view, slots: { "toolbar.secondary.sort": [{ id: "bad", widget: "collection.search", label: "Bad" }] } },
			{ ...view, slots: { "toolbar.primary.actions": [{ id: "bad", widget: "collection.refresh", label: "Bad", command: "inbox.mark-read" }] } },
			{ ...view, presentation: { ...view.presentation, active: "missing" } },
			{ ...view, presentation: { active: "grid", renderers: [{ ...view.presentation.renderers[0], fields: ["unknown"] }] } },
			{ ...view, presentation: { ...view.presentation, renderers: [...view.presentation.renderers, view.presentation.renderers[0]] } },
		]) expect(() => parseResourceViewDefinition(invalid, registry)).toThrow();
	});

	it("allows metadata to be omitted entirely and does not make renderer choice part of query identity", () => {
		const view = parseResourceViewDefinition(fixture, registry);
		const { insights, ...withoutInsights } = view;
		const cards = parseResourceViewDefinition({ ...withoutInsights, presentation: { ...view.presentation, active: "cards" } }, registry);
		expect(cards.insights).toBeUndefined();
		expect(cards.query).toEqual(view.query);
		expect(resolveResourceViewFeatures(cards, registry, new Set(["text"])).insights).toEqual([]);
	});
});
