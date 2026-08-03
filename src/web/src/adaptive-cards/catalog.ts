import eventCard from "./templates/event-card.json";
import messageCard from "./templates/message-card.json";
import resourceDetailCard from "./templates/resource-detail-card.json";
import resourceEditorCard from "./templates/resource-editor-card.json";

import type {
	CardJsonObject,
	CardTemplateDescriptor,
	CardTemplateId,
} from "../../../types/adaptive-cards";

interface CatalogEntry extends CardTemplateDescriptor {
	payload: CardJsonObject;
}

export const CARD_SCHEMA_VERSION = "1.5" as const;

export const CARD_CATALOG: Record<CardTemplateId, CatalogEntry> = {
	"workbench.event": {
		id: "workbench.event",
		version: 1,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Semantic event and status activity",
		surfaces: ["inbox", "stream", "panel", "popout"],
		allowedActions: ["resource.open", "attention.resolve"],
		payload: eventCard as CardJsonObject,
	},
	"workbench.message": {
		id: "workbench.message",
		version: 1,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Project message or conversation summary",
		surfaces: ["inbox", "detail", "panel", "popout"],
		allowedActions: ["message.open", "message.archive"],
		payload: messageCard as CardJsonObject,
	},
	"workbench.resource-detail": {
		id: "workbench.resource-detail",
		version: 1,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Singleton resource detail",
		surfaces: ["detail", "panel", "popout"],
		allowedActions: ["resource.open"],
		payload: resourceDetailCard as CardJsonObject,
	},
	"workbench.resource-editor": {
		id: "workbench.resource-editor",
		version: 1,
		schemaVersion: CARD_SCHEMA_VERSION,
		description: "Allowlisted singleton resource editor",
		surfaces: ["editor", "panel"],
		allowedActions: ["task.update", "bug.update"],
		payload: resourceEditorCard as CardJsonObject,
	},
};

export function getCardTemplate(id: CardTemplateId, version: number): CardJsonObject | null {
	const entry = CARD_CATALOG[id];
	return entry.version === version ? entry.payload : null;
}
