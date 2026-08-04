/**
 * Host-owned contracts for Adaptive Card projections.
 *
 * Card templates are presentation resources. Resource state and permissions
 * remain authoritative in Coleo's domain APIs.
 */

export type CardJsonPrimitive = string | number | boolean | null;
export type CardJsonValue = CardJsonPrimitive | CardJsonObject | CardJsonValue[];

export interface CardJsonObject {
	[key: string]: CardJsonValue | undefined;
}

export type CardSurface =
	| "inbox"
	| "stream"
	| "detail"
	| "editor"
	| "panel"
	| "popout";

export type CardTemplateId =
	| "workbench.event"
	| "workbench.message"
	| "workbench.resource-detail"
	| "workbench.resource-editor";

export interface CardTemplateRef {
	id: CardTemplateId;
	version: number;
}

export interface CardResourceRef {
	kind: string;
	id: string;
}

export type CardCreatorKind = "brain" | "arm" | "user";

export interface CardCreator {
	kind: CardCreatorKind;
	id: string;
	displayName: string;
}

export interface CardPresentation {
	surface: CardSurface;
	compact?: boolean;
	title?: string;
}

export interface CardEnvelope {
	id: string;
	template: CardTemplateRef;
	schemaVersion: "1.5";
	presentation: CardPresentation;
	data: CardJsonObject;
	resource?: CardResourceRef;
	creator?: CardCreator;
	correlationId?: string;
	createdAt: string;
	expiresAt?: string;
}

export interface CardActionRequest {
	envelopeId: string;
	template: CardTemplateRef;
	actionId: string;
	verb: string;
	resource?: CardResourceRef;
	inputs: CardJsonObject;
	clientActionId: string;
	expectedResourceVersion?: string;
}

export interface CardActionResult {
	ok: boolean;
	clientActionId: string;
	message: string;
	envelope?: CardEnvelope;
	navigateTo?: {
		pathname: string;
		search?: string;
		title?: string;
	};
}

export interface CardTemplateDescriptor {
	id: CardTemplateId;
	version: number;
	schemaVersion: "1.5";
	description: string;
	surfaces: CardSurface[];
	allowedActions: string[];
}

export interface WorkbenchAttention {
	profileId: string;
	itemKey: string;
	seenAt?: string;
	readAt?: string;
	archivedAt?: string;
	snoozedUntil?: string;
	resolvedAt?: string;
	assignedTo?: string;
	requiresAction: boolean;
	updatedAt: string;
}

export interface WorkbenchInboxRecord {
	itemKey: string;
	source: "status-report" | "task" | "bug";
	kind: "status" | "task" | "bug";
	title: string;
	summary: string;
	timestamp: string;
	resource: CardResourceRef;
	severity: "info" | "success" | "warning" | "danger";
	requiresAction: boolean;
	attention?: WorkbenchAttention;
}
