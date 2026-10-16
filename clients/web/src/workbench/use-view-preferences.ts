/**
 * Debounced bridge between interactive projection state and database-backed
 * saved-view preferences.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useSavedView } from "./profile-context";

import type { ViewDefinition, ViewPreferences } from "./types";

export function useViewPreferences(
	viewId: string,
	defaults: Omit<ViewDefinition, "profileId" | "key" | "createdAt" | "updatedAt" | "version">,
) {
	const { view, savePreferences, saveDefinition, isPersisted } = useSavedView(viewId, defaults);
	const [preferences, setPreferences] = useState<ViewPreferences>(view.preferences);
	const dirtyRef = useRef(false);

	useEffect(() => {
		if (!dirtyRef.current) setPreferences(view.preferences);
	}, [view.preferences, view.version]);

	useEffect(() => {
		if (!dirtyRef.current) return;
		const timer = window.setTimeout(() => {
			void savePreferences(preferences).finally(() => {
				dirtyRef.current = false;
			});
		}, 500);
		return () => window.clearTimeout(timer);
	}, [preferences, savePreferences]);

	const updatePreferences = useCallback((next: ViewPreferences) => {
		dirtyRef.current = true;
		setPreferences(next);
	}, []);

	const updateShared = useCallback(async (shared: boolean) => {
		await saveDefinition({
			...view,
			preferences,
			shared,
			updatedAt: new Date().toISOString(),
		});
	}, [preferences, saveDefinition, view]);

	return {
		view,
		preferences,
		updatePreferences,
		updateShared,
		isPersisted,
	};
}
