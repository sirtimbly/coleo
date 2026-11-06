/** Debounced, serialized persistence scoped to the active profile and view. */
import { createElement, useEffect, useMemo, useSyncExternalStore } from "react";

import { useSavedView } from "./profile-context";
import { ViewPreferenceSave } from "./view-preference-save";
import { ViewPreferenceSaveStatus } from "./ViewPreferenceSaveStatus";

import type { ViewDefinition } from "./types";

export function useViewPreferences(
	viewId: string,
	defaults: Omit<ViewDefinition, "profileId" | "key" | "createdAt" | "updatedAt" | "version">,
) {
	const { view, saveDefinition, isPersisted, profileId } = useSavedView(viewId, defaults);
	// Capture the writer with its identity, never retarget an in-flight save.
	const session = useMemo(() => new ViewPreferenceSave(view, saveDefinition),
		// The initial view/writer belong to this identity; subsequent confirmations are synchronized below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[profileId, viewId]);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	useEffect(() => {
		// Bootstrap may resolve an imported view ID after the initial render.
		session.setWriter(saveDefinition);
		session.confirm(view);
	}, [session, view, saveDefinition]);

	return {
		view: state.view,
		preferences: state.view.preferences,
		updatePreferences: session.updatePreferences,
		updateShared: session.updateShared,
		isPersisted,
		saving: state.saving,
		error: state.error,
		dirty: state.dirty,
		retry: session.retry,
		lastConfirmed: state.lastConfirmed,
		saveStatus: createElement(ViewPreferenceSaveStatus, { state, retry: session.retry }),
	};
}
