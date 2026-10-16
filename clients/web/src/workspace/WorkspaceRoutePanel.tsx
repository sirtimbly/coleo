import { SquareStack } from "lucide-react";
import { findAppRoute } from "@/app/routes";
import { ScreenErrorBoundary } from "@/components/ScreenErrorBoundary";
import { WorkspaceRouteProvider } from "./route-context";
import type { WorkspaceOpenMode, WorkspaceRouteState } from "./route-context";

interface Props {
	route: WorkspaceRouteState;
	onRouteChange: (route: WorkspaceRouteState) => void;
	onOpenRoute: (route: WorkspaceRouteState, mode?: WorkspaceOpenMode) => void;
	onCloseRoute: () => void;
}

function RouteContent({ route }: Pick<Props, "route">) {
	const matched = findAppRoute(route.pathname);
	if (!matched) return <div className="flex h-full items-center justify-center text-center">
		<div className="space-y-2"><SquareStack className="mx-auto h-10 w-10 text-muted-foreground" />
			<p className="font-medium">Unknown panel route</p><p className="text-sm text-muted-foreground">{route.pathname}</p></div>
	</div>;
	const RouteComponent = matched.component;
	return <RouteComponent />;
}

export function WorkspaceRoutePanel(props: Props) {
	return <div className="golden-workspace-panel">
		<ScreenErrorBoundary name={props.route.title || "this tab"}
			resetKey={`${props.route.pathname}${props.route.search}`} onClose={props.onCloseRoute}>
			<WorkspaceRouteProvider {...props}>
				<RouteContent route={props.route} />
			</WorkspaceRouteProvider>
		</ScreenErrorBoundary>
	</div>;
}
