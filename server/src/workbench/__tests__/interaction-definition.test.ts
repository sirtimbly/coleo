import { describe, expect, it } from "bun:test";

import { createInteractionInvocation, matchInteractionKey, validateInteractionDefinition } from "../interaction-definition";
import { MESSAGING_INTERACTIONS, WORKBENCH_RESERVED_KEYS } from "../messaging-interactions";
import { getNamedResourceView, resolveNamedResourceView } from "../named-resource-views";

const web = getNamedResourceView("inbox-triage", "web")!;
const cli = getNamedResourceView("inbox-triage", "cli")!;
const key = (key: string, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });

describe("shared interaction definitions", () => {
	it("preserves resource/query/composition meaning across clients and discloses presentation fallbacks", () => {
		const tui = getNamedResourceView("inbox-triage", "tui")!;
		expect(cli.definition).toEqual(web.definition);
		expect(tui.queryIdentity).toBe(web.queryIdentity);
		expect(cli.features.presentation[1]).toMatchObject({ id: "cards", implementation: "collection.list" });
		expect(web.features.presentation[2]).toMatchObject({ id: "timeline", implementation: "collection.list" });
		expect(web.features.insights[0]).toMatchObject({ implementation: "metadata.summary" });
		expect(web.definition.hierarchy?.selectionScope).toBe("loaded-descendants");
		expect(web.interactions.bindings.find((binding) => binding.id === "next")?.diagnostic).toContain("No web adapter");
	});

	it("shares search values with CLI flags and enforces enum, arity, page size, and exact command targets", () => {
		const search = cli.interactions.bindings.find((binding) => binding.cli && "flag" in binding.cli && binding.cli.flag === "--search")!;
		expect(createInteractionInvocation(search, "Review API")).toMatchObject({ operation: "collection.search", binding: "query.search", value: "Review API" });
		expect(createInteractionInvocation(web.interactions.bindings.find((binding) => binding.id === "search")!, "Review API"))
			.toEqual(createInteractionInvocation(search, "Review API"));
		const sort = cli.interactions.bindings.find((binding) => binding.id === "sort")!;
		expect(() => createInteractionInvocation(sort, "newest")).toThrow("expected asc, desc");
		const limit = cli.interactions.bindings.find((binding) => binding.id === "limit")!;
		expect(createInteractionInvocation(limit, "20").value).toBe(20);
		for (const value of ["", "1.5", "1000", "-1", undefined]) expect(() => createInteractionInvocation(limit, value)).toThrow();
		expect(() => createInteractionInvocation(cli.interactions.bindings.find((binding) => binding.id === "help")!, "extra")).toThrow("does not accept");
		expect(createInteractionInvocation(cli.interactions.bindings.find((binding) => binding.id === "mark-read")!, ["message:exact-id"]))
			.toMatchObject({ command: "inbox.mark-read", target: "selected-items", value: ["message:exact-id"] });
	});

	it("replaces inherited bindings deterministically and allows explicit removal", () => {
		const overridden = resolveNamedResourceView({ ...web.definition, interactions: [
			{ id: "search", operation: "collection.search", keyboard: { shared: [{ key: "f" }] }, cli: { flag: "--find" } },
			{ id: "refresh", operation: "collection.refresh", disabled: true },
		] }, "web");
		expect(overridden.interactions.bindings.filter((binding) => binding.id === "search")).toHaveLength(1);
		expect(matchInteractionKey(overridden.interactions.bindings, key("/"), "collection", "other")).toBeUndefined();
		expect(matchInteractionKey(overridden.interactions.bindings, key("f"), "collection", "other")?.operation).toBe("collection.search");
		expect(overridden.interactions.bindings.some((binding) => binding.id === "refresh")).toBe(false);
	});

	it("rejects inherited scope conflicts, duplicate flags/aliases, unknown operations/profiles, and undeclared commands", () => {
		for (const interactions of [
			[{ id: "collision", operation: "collection.search", keyboard: { shared: [{ key: "r", scope: "tree" }] } }],
			[{ id: "collision", operation: "collection.search", keyboard: { shared: [{ key: "?", modifiers: ["shift"] }] } }],
			[{ id: "invalid-key", operation: "collection.search", keyboard: { shared: [{ key: "not-a-key" }] } }],
			[{ id: "collision", operation: "collection.search", cli: { flag: "--search" } }],
			[{ id: "collision", operation: "collection.search", cli: { flag: "--find", alias: "-s" } }],
			[{ id: "unknown", operation: "arbitrary.javascript" }],
			[{ id: "same", operation: "collection.search" }, { id: "same", operation: "collection.search" }],
		]) expect(() => resolveNamedResourceView({ ...web.definition, interactions }, "web")).toThrow();
		expect(() => resolveNamedResourceView({ ...web.definition, interactionProfile: "missing" }, "web")).toThrow("Unknown interaction profile");
		expect(() => resolveNamedResourceView({ ...web.definition, commands: ["inbox.open", "inbox.refresh"] }, "web")).toThrow("must be declared");
		expect(() => resolveNamedResourceView({ ...web.definition, schemaVersion: 2 }, "web")).toThrow();
	});

	it("checks host-reserved keys across both platform interpretations of primary", () => {
		for (const modifiers of [["meta"], ["control"], ["primary"]]) {
			expect(() => validateInteractionDefinition({ ...web.definition, interactions: [
				{ id: "search", operation: "collection.search", keyboard: { shared: [{ key: "p", modifiers, scope: "item" }] } },
			] } as Parameters<typeof validateInteractionDefinition>[0], MESSAGING_INTERACTIONS, { web: WORKBENCH_RESERVED_KEYS })).toThrow("host-reserved");
		}
	});

	it("retains shared terminal keys while allowing a declared browser-specific override", () => {
		const definition = { ...web.definition, interactions: [{ id: "search", operation: "collection.search",
			keyboard: { shared: [{ key: "/" }], web: [{ key: "f", modifiers: ["alt"] }] }, cli: { flag: "--search", alias: "-s" } }] };
		const browser = resolveNamedResourceView(definition, "web");
		const terminal = resolveNamedResourceView(definition, "tui");
		expect(matchInteractionKey(browser.interactions.bindings, key("f", { altKey: true }), "collection", "other")?.operation).toBe("collection.search");
		expect(matchInteractionKey(browser.interactions.bindings, key("/"), "collection", "other")).toBeUndefined();
		expect(matchInteractionKey(terminal.interactions.bindings, key("/"), "collection", "other")?.operation).toBe("collection.search");
		expect(browser.queryIdentity).toBe(terminal.queryIdentity);
	});

	it("reserves browser shortcuts even in a view's help scope", () => {
		expect(() => resolveNamedResourceView({ ...web.definition, interactions: [
			{ id: "search", operation: "collection.search", keyboard: { shared: [{ key: "r", modifiers: ["control"], scope: "help" }] } },
		] }, "web")).toThrow("host-reserved");
	});

	it("matches printable symbols without intercepting modified browser shortcuts and isolates help scope", () => {
		expect(matchInteractionKey(web.interactions.bindings, key("?", { shiftKey: true }), "collection", "other")?.operation).toBe("collection.help");
		expect(matchInteractionKey(web.interactions.bindings, key("r", { metaKey: true }), "collection", "mac")).toBeUndefined();
		expect(matchInteractionKey(web.interactions.bindings, key("r", { ctrlKey: true }), "collection", "other")).toBeUndefined();
		expect(matchInteractionKey(web.interactions.bindings, key("r"), "help", "other")).toBeUndefined();
		expect(matchInteractionKey(web.interactions.bindings, key("Escape"), "help", "other")?.operation).toBe("collection.back");
	});
});
