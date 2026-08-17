import { useCallback } from "react";

import { useViewPreferences } from "./use-view-preferences";

import type { ResourceKind, ViewPreferences } from "./types";
import type { CardPresentationMode } from "@/adaptive-cards/card-presentation";

export type CollectionDisplayMode = "grid" | "cards";
export type CardColumnCount = 1 | 2 | 3 | 4;

export interface CollectionDisplayPreferences {
	mode: CollectionDisplayMode;
	density: "compact" | "comfortable";
	cardColumns: CardColumnCount;
	cardPresentation: CardPresentationMode;
}

const DEFAULT_DISPLAY: CollectionDisplayPreferences = {
	mode: "grid",
	density: "compact",
	cardColumns: 2,
	cardPresentation: "compact",
};

function readDisplayPreferences(preferences: ViewPreferences): CollectionDisplayPreferences {
	const extras = preferences.extras;
	const mode = extras?.collectionDisplayMode;
	const cardColumns = extras?.cardColumns;
	const cardPresentation = extras?.cardPresentation;
	return {
		mode: mode === "cards" ? "cards" : "grid",
		density: preferences.density === "comfortable" ? "comfortable" : "compact",
		cardColumns: cardColumns === 1 || cardColumns === 2 || cardColumns === 3 || cardColumns === 4
			? cardColumns
			: DEFAULT_DISPLAY.cardColumns,
		cardPresentation: cardPresentation === "detail" ? "detail" : "compact",
	};
}

export function useCollectionDisplayPreferences({
	viewId,
	name,
	resourceKind,
	defaultMode = DEFAULT_DISPLAY.mode,
}: {
	viewId: string;
	name: string;
	resourceKind?: ResourceKind;
	defaultMode?: CollectionDisplayMode;
}) {
	const controller = useViewPreferences(viewId, {
		id: viewId,
		name: `${name} display`,
		kind: "sheet",
		resourceKind,
		description: `Display preferences for the ${name.toLowerCase()} collection`,
		query: resourceKind ? { resourceKinds: [resourceKind] } : {},
		preferences: {
			density: DEFAULT_DISPLAY.density,
			extras: {
				collectionDisplayMode: defaultMode,
				cardColumns: DEFAULT_DISPLAY.cardColumns,
				cardPresentation: DEFAULT_DISPLAY.cardPresentation,
			},
		},
		shared: false,
	});
	const display = readDisplayPreferences(controller.preferences);

	const updateDisplay = useCallback((updates: Partial<CollectionDisplayPreferences>) => {
		const current = readDisplayPreferences(controller.preferences);
		const next = { ...current, ...updates };
		controller.updatePreferences({
			...controller.preferences,
			density: next.density,
			extras: {
				...controller.preferences.extras,
				collectionDisplayMode: next.mode,
				cardColumns: next.cardColumns,
				cardPresentation: next.cardPresentation,
			},
		});
	}, [controller]);

	return { display, updateDisplay };
}
