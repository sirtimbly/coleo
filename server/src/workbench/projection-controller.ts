/** One request owner per normalized query. Events coalesce against a fixed deadline, not trailing silence. */
export interface ProjectionControllerSnapshot<T> {
	readonly value: T | undefined;
	readonly loading: boolean;
	readonly error: Error | null;
}

export class ProjectionController<T> {
	private snapshot: ProjectionControllerSnapshot<T> = { value: undefined, loading: false, error: null };
	private readonly listeners = new Set<() => void>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private busy = false;
	private pending = false;
	private waiters: Array<() => void> = [];
	private disposed = false;
	private refreshedAt = 0;
	private mutationDepth = 0;
	private readGeneration = 0;
	private abort: AbortController | null = null;
	private readonly fetcher: (signal: AbortSignal, previous: T | undefined) => Promise<T>;
	private readonly delayMs: number;

	constructor(fetcher: (signal: AbortSignal, previous: T | undefined) => Promise<T>, delayMs = 200) {
		this.fetcher = fetcher; this.delayMs = delayMs;
	}

	getSnapshot = (): ProjectionControllerSnapshot<T> => this.snapshot;
	get active(): boolean { return this.listeners.size > 0; }
	subscribe = (listener: () => void): (() => void) => {
		const first = this.listeners.size === 0;
		this.listeners.add(listener);
		if (!this.busy && !this.timer && (this.snapshot.value === undefined || first && Date.now() - this.refreshedAt > 1000)) this.schedule();
		return () => { this.listeners.delete(listener); };
	};

	schedule(): void {
		if (this.disposed) return;
		if (this.mutationDepth > 0) { this.pending = true; return; }
		if (this.busy) { this.pending = true; return; }
		if (this.timer) return;
		this.timer = setTimeout(() => { this.timer = null; void this.execute(); }, this.snapshot.value === undefined ? 0 : this.delayMs);
	}

	refresh(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const done = new Promise<void>((resolve) => this.waiters.push(resolve));
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (this.busy || this.mutationDepth > 0) this.pending = true;
		else void this.execute();
		return done;
	}

	/** Ignore intermediate write hints as refresh triggers; release performs one canonical post-write refresh. */
	beginMutation(): () => Promise<void> {
		this.mutationDepth++;
		this.readGeneration++;
		this.abort?.abort();
		if (this.snapshot.loading) this.publish({ ...this.snapshot, loading: false });
		if (this.timer) { clearTimeout(this.timer); this.timer = null; this.pending = true; }
		let released = false;
		return () => {
			if (released) return Promise.resolve();
			released = true;
			this.mutationDepth = Math.max(0, this.mutationDepth - 1);
			return this.refresh();
		};
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.abort?.abort();
		for (const resolve of this.waiters.splice(0)) resolve();
		this.listeners.clear();
	}

	private publish(snapshot: ProjectionControllerSnapshot<T>): void {
		if (this.disposed) return;
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}

	private async execute(): Promise<void> {
		if (this.disposed || this.busy || this.mutationDepth > 0) return;
		this.busy = true;
		this.pending = false;
		const generation = this.readGeneration;
		const waiters = this.waiters.splice(0);
		this.abort = new AbortController();
		this.publish({ ...this.snapshot, loading: true, error: null });
		try {
			const value = await this.fetcher(this.abort.signal, this.snapshot.value);
			if (generation === this.readGeneration && this.mutationDepth === 0) {
				this.refreshedAt = Date.now();
				this.publish({ value, loading: false, error: null });
			}
		} catch (error) {
			if (generation === this.readGeneration && this.mutationDepth === 0) {
				this.publish({ ...this.snapshot, loading: false, error: error instanceof Error ? error : new Error(String(error)) });
			}
		} finally {
			this.busy = false;
			this.abort = null;
			for (const resolve of waiters) resolve();
			if (!this.disposed && this.pending && this.mutationDepth === 0) void this.execute();
		}
	}
}
