import { describe, expect, it } from "bun:test";

import { CARD_CATALOG, getCardTemplate, isCardActionAllowed } from "../src/adaptive-cards/catalog";
import { createCardRoute, parseCardRoute } from "../src/adaptive-cards/card-route";
import { expandCardTemplate } from "../src/adaptive-cards/expand-template";
import { presentInboxItem, presentResourceEditor } from "../src/adaptive-cards/presenters";

describe("adaptive card contracts", () => {
	it("pins every trusted template to schema 1.5 and a positive version", () => {
		for (const entry of Object.values(CARD_CATALOG)) {
			expect(entry.schemaVersion).toBe("1.5");
			expect(entry.version).toBeGreaterThan(0);
			expect(getCardTemplate(entry.id, entry.version)).not.toBeNull();
			expect(getCardTemplate(entry.id, entry.version + 1)).toBeNull();
		}
	});

	it("allowlists verbs per template instead of trusting card data", () => {
		expect(isCardActionAllowed("workbench.event", 1, "attention.resolve")).toBe(true);
		expect(isCardActionAllowed("workbench.event", 1, "task.update")).toBe(false);
		expect(isCardActionAllowed("workbench.resource-editor", 1, "task.update")).toBe(true);
		expect(isCardActionAllowed("workbench.resource-editor", 2, "task.update")).toBe(false);
	});

	it("round trips a versioned card through a persistent workspace route", () => {
		const envelope = presentInboxItem({
			id: "event:test",
			kind: "system",
			title: "Test event",
			summary: "The event is readable.",
			timestamp: "2026-08-03T12:00:00.000Z",
			unread: true,
			requiresAction: true,
			severity: "warning",
		});
		const route = createCardRoute(
			"018fd384-7c9a-7a83-8fd8-6f6f0c96af95",
			envelope.presentation.title,
		);
		expect(route.pathname).toBe("/card");
		expect(parseCardRoute(new URLSearchParams(route.search)))
			.toBe("018fd384-7c9a-7a83-8fd8-6f6f0c96af95");
	});

	it("creates scalar editors with a resource-scoped save verb", () => {
		const envelope = presentResourceEditor({
			id: "task-1",
			kind: "task",
			title: "Write tests",
			description: "Cover the action dispatcher.",
		});
		expect(envelope.resource).toEqual({ kind: "task", id: "task-1" });
		expect(envelope.data.saveVerb).toBe("task.update");
		expect(envelope.template).toEqual({
			id: "workbench.resource-editor",
			version: 1,
		});
	});

	it("expands only the trusted template expression subset", () => {
		const template = getCardTemplate("workbench.event", 1);
		expect(template).not.toBeNull();
		const expanded = expandCardTemplate(template!, {
			eyebrow: "Test",
			title: "Blocked",
			summary: "Needs input",
			tone: "warning",
			timestampLabel: "now",
			requiresAction: true,
			facts: [{ label: "Task", value: "task-1" }],
			openVerb: null,
		});
		const serialized = JSON.stringify(expanded);
		expect(serialized).not.toContain("${");
		expect(serialized).not.toContain("$when");
		expect(serialized).not.toContain("$data");
		expect(serialized).toContain('"title":"Task"');
		expect((expanded.actions as unknown[])).toHaveLength(3);
	});
});
