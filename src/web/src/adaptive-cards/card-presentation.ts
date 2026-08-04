import { useSyncExternalStore } from "react";

export type CardPresentationMode = "compact" | "detail";
export type GlobalCardPresentationMode = CardPresentationMode | "surface";

const STORAGE_KEY = "coleo-card-presentation";
const globalListeners = new Set<() => void>();
const itemListeners = new Map<string, Set<() => void>>();
const itemOverrides = new Map<string, CardPresentationMode>();
const itemRevisions = new Map<string, number>();

let globalRevision = 0;
let globalMode: GlobalCardPresentationMode | undefined;

function readGlobalMode(): GlobalCardPresentationMode {
	if (globalMode) return globalMode;
	if (typeof window === "undefined") return "surface";
	const saved = window.localStorage.getItem(STORAGE_KEY);
	globalMode = saved === "compact" || saved === "detail" ? saved : "surface";
	return globalMode;
}

function emitGlobal(): void {
	globalRevision++;
	for (const listener of globalListeners) listener();
}

function emitItem(id: string): void {
	itemRevisions.set(id, (itemRevisions.get(id) ?? 0) + 1);
	for (const listener of itemListeners.get(id) ?? []) listener();
}

function subscribe(id: string, listener: () => void): () => void {
	globalListeners.add(listener);
	const listeners = itemListeners.get(id) ?? new Set<() => void>();
	listeners.add(listener);
	itemListeners.set(id, listeners);
	return () => {
		globalListeners.delete(listener);
		listeners.delete(listener);
		if (listeners.size === 0) itemListeners.delete(id);
	};
}

function getSnapshot(id: string): string {
	return `${globalRevision}:${itemRevisions.get(id) ?? 0}`;
}

export function getEffectiveCardPresentation(
	id: string,
	surfaceDefault: CardPresentationMode,
): CardPresentationMode {
	const override = itemOverrides.get(id);
	if (override) return override;
	const saved = readGlobalMode();
	return saved === "surface" ? surfaceDefault : saved;
}

export function setCardPresentation(id: string, mode: CardPresentationMode): void {
	itemOverrides.set(id, mode);
	emitItem(id);
}

export function clearCardPresentation(id: string): void {
	if (!itemOverrides.delete(id)) return;
	emitItem(id);
}

export function setAllCardPresentations(mode: GlobalCardPresentationMode): void {
	globalMode = mode;
	itemOverrides.clear();
	itemRevisions.clear();
	if (typeof window !== "undefined") {
		if (mode === "surface") window.localStorage.removeItem(STORAGE_KEY);
		else window.localStorage.setItem(STORAGE_KEY, mode);
	}
	emitGlobal();
}

export function useCardPresentation(
	id: string,
	surfaceDefault: CardPresentationMode,
) {
	useSyncExternalStore(
		(listener) => subscribe(id, listener),
		() => getSnapshot(id),
		() => "0:0",
	);
	return {
		mode: getEffectiveCardPresentation(id, surfaceDefault),
		globalMode: readGlobalMode(),
		hasOverride: itemOverrides.has(id),
		setForCard: (mode: CardPresentationMode) => setCardPresentation(id, mode),
		clearForCard: () => clearCardPresentation(id),
		setForAll: (mode: GlobalCardPresentationMode) => setAllCardPresentations(mode),
	};
}
