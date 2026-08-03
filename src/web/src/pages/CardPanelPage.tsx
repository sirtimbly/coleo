import { Button } from "@heroui/react";
import { ExternalLink, PanelsTopLeft } from "lucide-react";

import { AdaptiveCardView } from "@/adaptive-cards/AdaptiveCardView";
import { parseCardRoute } from "@/adaptive-cards/card-route";
import { api } from "@/lib";
import { WorkbenchEmptyState, WorkbenchHeader } from "@/design-system/WorkbenchSurface";
import {
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from "@/workspace/route-context";

import type { CardActionRequest } from "../../../types/adaptive-cards";

export function CardPanelPage() {
	const [searchParams] = useWorkspaceSearchParams();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const envelope = parseCardRoute(searchParams);

	if (!envelope) {
		return (
			<WorkbenchEmptyState
				title="Card unavailable"
				description="This panel does not contain a supported card envelope."
			/>
		);
	}

	const handleAction = async (request: CardActionRequest) => {
		if (request.verb === "resource.open") {
			const target = envelope.data.targetRoute;
			if (target && typeof target === "object" && !Array.isArray(target)) {
				const pathname = target.pathname;
				if (typeof pathname === "string" && pathname.startsWith("/")) {
					openWorkspaceRoute({
						pathname,
						search: typeof target.search === "string" ? target.search : "",
						title: typeof target.title === "string" ? target.title : undefined,
					}, "focus");
				}
			}
			return;
		}
		const result = await api.executeWorkbenchCardAction(request);
		if (result.navigateTo) {
			openWorkspaceRoute({
				pathname: result.navigateTo.pathname,
				search: result.navigateTo.search ?? "",
				title: result.navigateTo.title,
			}, "focus");
		}
	};

	const openPopout = () => {
		const url = `${window.location.origin}/card?${searchParams.toString()}`;
		const popout = window.open(
			url,
			`coleo-card-${envelope.id}`,
			"popup,noopener,noreferrer,width=720,height=800",
		);
		if (popout) popout.opener = null;
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<WorkbenchHeader
				title={envelope.presentation.title ?? "Card"}
				description={`${envelope.template.id}@${envelope.template.version}`}
				icon={<PanelsTopLeft className="h-4 w-4" />}
				actions={(
					<Button size="sm" variant="ghost" onPress={openPopout}>
						<ExternalLink className="h-3.5 w-3.5" />
						Pop out
					</Button>
				)}
			/>
			<div className="min-h-0 flex-1 overflow-auto p-4">
				<AdaptiveCardView
					envelope={envelope}
					onAction={handleAction}
					className="mx-auto max-w-3xl"
				/>
			</div>
		</div>
	);
}
