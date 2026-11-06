import type { ViewDefinition, ViewPreferences } from "./types";

export interface ViewPreferenceSaveState {
	view: ViewDefinition;
	lastConfirmed: ViewDefinition;
	saving: boolean;
	dirty: boolean;
	error: Error | null;
}

/** One ordered stream of edits for a single profile/view identity. */
export class ViewPreferenceSave {
	private state: ViewPreferenceSaveState;
	private revision = 0;
	private listeners = new Set<() => void>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private save: (view: ViewDefinition) => Promise<ViewDefinition>;
	private delay: number;

	constructor(
		view: ViewDefinition,
		save: (view: ViewDefinition) => Promise<ViewDefinition>,
		delay = 500,
	) {
		this.save = save;
		this.delay = delay;
		this.state = { view, lastConfirmed: view, saving: false, dirty: false, error: null };
	}

	getSnapshot = (): ViewPreferenceSaveState => this.state;

	setWriter(save: (view: ViewDefinition) => Promise<ViewDefinition>): void {
		this.save = save;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		if (this.state.dirty && !this.state.error) this.schedule();
		return () => {
			this.listeners.delete(listener);
			if (!this.listeners.size) clearTimeout(this.timer);
		};
	};

	private publish(state: ViewPreferenceSaveState) {
		this.state = state;
		for (const listener of this.listeners) listener();
	}

	// Background refetches must never replace pending local edits.
	confirm(view: ViewDefinition): void {
		if (this.state.dirty || this.state.saving || view === this.state.lastConfirmed) return;
		this.publish({ ...this.state, view, lastConfirmed: view });
	}

	updatePreferences = (preferences: ViewPreferences): void => {
		this.edit({ ...this.state.view, preferences });
	};

	updateShared = (shared: boolean): void => {
		this.edit({ ...this.state.view, shared });
	};

	private edit(view: ViewDefinition) {
		this.revision++;
		this.publish({ ...this.state, view, dirty: true });
		// Failed edits stay visible until the user explicitly retries.
		if (!this.state.error) this.schedule();
	}

	private schedule() {
		clearTimeout(this.timer);
		if (!this.listeners.size || this.state.saving) return;
		this.timer = setTimeout(() => { void this.flush(); }, this.delay);
	}

	retry = (): void => { void this.flush(); };

	async flush(): Promise<void> {
		clearTimeout(this.timer);
		if (this.state.saving || !this.state.dirty || !this.listeners.size) return;
		const revision = this.revision;
		const submitted = this.state.view;
		this.publish({ ...this.state, saving: true, error: null });
		try {
			const confirmed = await this.save(submitted);
			const dirty = revision !== this.revision;
			this.publish({
				view: dirty ? { ...confirmed, preferences: this.state.view.preferences, shared: this.state.view.shared } : confirmed,
				lastConfirmed: confirmed,
				dirty,
				saving: false,
				error: null,
			});
			if (dirty) this.schedule();
		} catch (error) {
			this.publish({
				...this.state,
				saving: false,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
}
