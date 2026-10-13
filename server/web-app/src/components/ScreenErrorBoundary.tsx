import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
	children: ReactNode;
	name: string;
	resetKey?: string;
	onClose?: () => void;
}

interface State {
	failed: boolean;
	resetKey?: string;
}

/** Keeps a failed screen mounted as a recoverable placeholder without resetting its siblings. */
export class ScreenErrorBoundary extends Component<Props, State> {
	state: State = { failed: false, resetKey: this.props.resetKey };

	static getDerivedStateFromError(): Partial<State> {
		return { failed: true };
	}

	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		return props.resetKey !== state.resetKey
			? { failed: false, resetKey: props.resetKey }
			: null;
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error(`Could not render ${this.props.name}`, error, info.componentStack);
	}

	render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		return (
			<section role="alert" aria-label={`${this.props.name} failed`} className="flex h-full min-h-32 flex-col items-center justify-center gap-3 overflow-auto bg-background p-6 text-center text-foreground">
				<h2 className="text-lg font-semibold">Could not display {this.props.name}</h2>
				<p className="max-w-md text-sm text-muted-foreground">Try opening this view again. Any unsaved changes in this view may have been lost.</p>
				<div className="flex flex-wrap justify-center gap-2">
					<button type="button" className="rounded border border-border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-2" onClick={() => this.setState({ failed: false })}>Try again</button>
					{this.props.onClose && <button type="button" className="rounded border border-border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-2" onClick={this.props.onClose}>Close tab</button>}
				</div>
			</section>
		);
	}
}

/** Invoke third-party render callbacks inside React so their errors reach the boundary. */
export function BoundaryContent({ render }: { render: () => ReactNode }): ReactNode {
	return render();
}
