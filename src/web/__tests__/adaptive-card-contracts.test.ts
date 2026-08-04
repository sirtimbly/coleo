import { describe, expect, it } from "bun:test";

import { CARD_CATALOG, getCardTemplate, isCardActionAllowed } from "../src/adaptive-cards/catalog";
import { createCardRoute, parseCardRoute } from "../src/adaptive-cards/card-route";
import {
	BRAIN_CARD_CREATOR,
	createArmAvatarSource,
	createArmCardCreator,
	inferMessageCreator,
	USER_CARD_CREATOR,
} from "../src/adaptive-cards/card-creators";
import {
	clearCardPresentation,
	getEffectiveCardPresentation,
	setAllCardPresentations,
	setCardPresentation,
} from "../src/adaptive-cards/card-presentation";
import { expandCardTemplate } from "../src/adaptive-cards/expand-template";
import {
	presentInboxItem,
	presentMessage,
	presentResourceEditor,
} from "../src/adaptive-cards/presenters";
import {
	presentTaskCard,
	stripCardMarkdown,
	taskCardDescription,
} from "../src/adaptive-cards/task-presenter";

import type { Task } from "../src/lib/api";

describe("adaptive card contracts", () => {
	it("pins every trusted template to schema 1.5 and a positive version", () => {
		for (const entry of CARD_CATALOG) {
			expect(entry.schemaVersion).toBe("1.5");
			expect(entry.version).toBeGreaterThan(0);
			expect(getCardTemplate(entry.id, entry.version)).not.toBeNull();
		}
		expect(getCardTemplate("workbench.resource-detail", 99)).toBeNull();
	});

	it("allowlists verbs per template instead of trusting card data", () => {
		expect(isCardActionAllowed("workbench.event", 1, "attention.resolve")).toBe(true);
		expect(isCardActionAllowed("workbench.event", 1, "task.update")).toBe(false);
		expect(isCardActionAllowed("workbench.resource-editor", 1, "task.update")).toBe(true);
		expect(isCardActionAllowed("workbench.resource-editor", 2, "task.update")).toBe(true);
		expect(isCardActionAllowed("workbench.resource-editor", 2, "resource.open")).toBe(false);
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

	it("projects expanded inbox messages with a trusted conversation action", () => {
		const envelope = presentMessage({
			id: "thread-architecture",
			from: "brain@coleo.local",
			subject: "Workbench architecture",
			preview: "The Brain has a question.",
			timestamp: "2026-08-03T12:00:00.000Z",
			surface: "inbox",
			targetRoute: {
				pathname: "/messaging",
				search: "?facet=messages&thread=thread-architecture",
			},
		});
		expect(envelope.presentation).toMatchObject({
			surface: "inbox",
			title: "Workbench architecture",
		});
		expect(envelope.data).toMatchObject({
			openVerb: "message.open",
			targetRoute: {
				pathname: "/messaging",
				search: "?facet=messages&thread=thread-architecture",
			},
		});
		expect(isCardActionAllowed("workbench.message", 1, "message.open")).toBe(true);
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
			version: 2,
		});
	});

	it("projects task state without repeating imported plan prose", () => {
		const task = {
			id: "phase12c-c16448",
			subject: "**Add a multi-tabbed grid view.** Support sorting.",
			description: [
				"**Add a multi-tabbed grid view.** Support sorting.",
				"Plan phase: Phase 1.2: Collaborative planning.",
				"Phase context: **Goal**: Make planning clear.",
				"Task objective: **Add a multi-tabbed grid view.** Support sorting.",
			].join("\n\n"),
			status: "pending",
			priority: "high",
			sourceType: "plan",
			sourceRef: ".project/plan.md:120",
			phase: "Phase 1.2",
			classification: "frontend",
			domain: "web",
			assignedTo: null,
			createdAt: "2026-08-01T12:00:00.000Z",
			updatedAt: "2026-08-03T12:00:00.000Z",
			completedAt: null,
			claimedAt: null,
			startedAt: null,
			dueDate: null,
			artifacts: [],
			metadata: {},
			checklist: [],
		} satisfies Task;
		expect(stripCardMarkdown(task.subject)).toBe("Add a multi-tabbed grid view. Support sorting.");
		expect(taskCardDescription(task)).toBe("Context — Goal: Make planning clear.");

		const envelope = presentTaskCard(task, false, BRAIN_CARD_CREATOR);
		expect(envelope.template).toEqual({ id: "workbench.resource-detail", version: 2 });
		expect(envelope.data.title).toBe("Add a multi-tabbed grid view. Support sorting.");
		expect(envelope.data.description).toBe("Context — Goal: Make planning clear.");
		expect(envelope.data.technicalFacts).toContainEqual({
			label: "ID",
			value: "phase12c-c16448",
		});
		expect(JSON.stringify(envelope.data.facts)).not.toContain("phase12c-c16448");
	});

	it("uses typed task editor fields from the API contract", () => {
		const task = {
			id: "task-typed",
			subject: "Typed editor",
			description: "Use the right controls.",
			status: "in_progress",
			priority: "critical",
			sourceType: "manual",
			sourceRef: null,
			phase: "Phase 2",
			classification: null,
			domain: "frontend",
			assignedTo: null,
			progress: 35,
			createdAt: "2026-08-01T12:00:00.000Z",
			updatedAt: "2026-08-03T12:00:00.000Z",
			completedAt: null,
			claimedAt: null,
			startedAt: null,
			dueDate: "2026-08-20",
			artifacts: [],
			metadata: {},
		} satisfies Task;
		const envelope = presentTaskCard(task, true, USER_CARD_CREATOR);
		expect(envelope.template.version).toBe(2);
		expect(envelope.data).toMatchObject({
			showTaskFields: true,
			priority: "critical",
			dueDate: "2026-08-20",
			progress: 35,
			phase: "Phase 2",
			domain: "frontend",
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
			showAttentionActions: true,
			summaryMaxLines: 0,
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

	it("assigns stable Brain, Arm, and user creator identities", () => {
		expect(inferMessageCreator("Coleo Brain")).toEqual(BRAIN_CARD_CREATOR);
		expect(inferMessageCreator("operator@example.test", true)).toEqual(USER_CARD_CREATOR);
		expect(createArmCardCreator("arm-octavia", "Octavia").displayName).toBe("Octavia");
		expect(createArmAvatarSource("arm-octavia")).toBe(createArmAvatarSource("arm-octavia"));
		expect(createArmAvatarSource("arm-octavia")).not.toBe(createArmAvatarSource("arm-turing"));
	});

	it("applies presentation preferences per card or across all cards", () => {
		setAllCardPresentations("surface");
		expect(getEffectiveCardPresentation("card-a", "compact")).toBe("compact");
		expect(getEffectiveCardPresentation("card-b", "detail")).toBe("detail");
		setCardPresentation("card-a", "detail");
		expect(getEffectiveCardPresentation("card-a", "compact")).toBe("detail");
		expect(getEffectiveCardPresentation("card-b", "detail")).toBe("detail");
		setAllCardPresentations("compact");
		expect(getEffectiveCardPresentation("card-a", "detail")).toBe("compact");
		expect(getEffectiveCardPresentation("card-b", "detail")).toBe("compact");
		clearCardPresentation("card-a");
		setAllCardPresentations("surface");
		expect(getEffectiveCardPresentation("thread-card", "compact", "detail")).toBe("detail");
		setAllCardPresentations("compact");
		expect(getEffectiveCardPresentation("thread-card", "compact", "detail")).toBe("compact");
		setAllCardPresentations("surface");
	});
});
