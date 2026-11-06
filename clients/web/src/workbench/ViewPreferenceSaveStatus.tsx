import type { ViewPreferenceSaveState } from "./view-preference-save";

export function ViewPreferenceSaveStatus({ state, retry }: {
	state: ViewPreferenceSaveState;
	retry: () => void;
}) {
	if (!state.dirty && !state.saving) return null;
	return (
		<div role={state.error ? "alert" : "status"} className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
			{state.error ? (
				<>
					<span>Could not save {state.view.name} preferences. Your changes are still shown. {state.error.message}</span>
					<button type="button" className="underline hover:text-foreground focus-visible:outline focus-visible:outline-2" onClick={retry}>Retry save</button>
				</>
			) : state.saving ? "Saving view preferences…" : "View preferences not yet saved…"}
		</div>
	);
}
