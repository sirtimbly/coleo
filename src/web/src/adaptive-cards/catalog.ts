import eventCard from "./templates/event-card.json";
import messageCard from "./templates/message-card.json";
import resourceDetailCard from "./templates/resource-detail-card.json";
import resourceDetailCardV2 from "./templates/resource-detail-card-v2.json";
import resourceEditorCard from "./templates/resource-editor-card.json";
import resourceEditorCardV2 from "./templates/resource-editor-card-v2.json";

import type {
	CardJsonObject,
	CardTemplateDescriptor,
	CardTemplateId,
} from "../../../types/adaptive-cards";

interface CatalogEntry extends CardTemplateDescriptor {
	payload: CardJsonObject;
}

export const CARD_SCHEMA_VERSION = "1.5" as const;

export const CARD_CATALOG: readonly CatalogEntry[] = [
	{
		id: "workbench.event",
		version: 1,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Semantic event and status activity",
		surfaces: ["inbox", "stream", "panel", "popout"],
		allowedActions: [
			"resource.open",
			"attention.resolve",
			"attention.snooze",
			"attention.assign",
		],
		payload: eventCard as CardJsonObject,
	},
	{
		id: "workbench.message",
		version: 1,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Project message or conversation summary",
		surfaces: ["inbox", "detail", "panel", "popout"],
		allowedActions: ["message.open", "message.archive"],
		payload: messageCard as CardJsonObject,
	},
	{
		id: "workbench.resource-detail",
		version: 1,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Singleton resource detail",
		surfaces: ["detail", "panel", "popout"],
		allowedActions: ["resource.open"],
		payload: resourceDetailCard as CardJsonObject,
	},
	{
		id: "workbench.resource-editor",
		version: 1,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Allowlisted singleton resource editor",
		surfaces: ["editor", "panel"],
		allowedActions: ["task.update", "bug.update"],
		payload: resourceEditorCard as CardJsonObject,
	},
	{
		id: "workbench.resource-detail",
		version: 2,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Structured singleton resource detail with progressive disclosure",
		surfaces: ["detail", "panel", "popout"],
		allowedActions: ["resource.open"],
		payload: resourceDetailCardV2 as CardJsonObject,
	},
	{
		id: "workbench.resource-editor",
		version: 2,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Typed, allowlisted singleton resource editor",
		surfaces: ["editor", "panel"],
		allowedActions: ["task.update", "bug.update"],
		payload: resourceEditorCardV2 as CardJsonObject,
	},
] as const;

export function getCardTemplate(id: CardTemplateId, version: number): CardJsonObject | null {
	return CARD_CATALOG.find((entry) => entry.id === id && entry.version === version)?.payload ?? null;
}

export function isCardActionAllowed(
	id: CardTemplateId,
	version: number,
	verb: string,
): boolean {
	const entry = CARD_CATALOG.find((candidate) => candidate.id === id && candidate.version === version);
	return entry?.allowedActions.includes(verb) ?? false;
}
