import { Button } from "@heroui/react";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { AdaptiveCardView } from "@/adaptive-cards/AdaptiveCardView";
import { parseCardRoute } from "@/adaptive-cards/card-route";
import { api } from "@/lib";
import { WorkbenchEmptyState } from "@/design-system/WorkbenchSurface";
import {
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from "@/workspace/route-context";

import type { CardActionRequest, CardEnvelope } from "../../../types/adaptive-cards";

export function CardPanelPage() {
	const [searchParams] = useWorkspaceSearchParams();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const instanceId = parseCardRoute(searchParams);
	const [envelope, setEnvelope] = useState<CardEnvelope | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		if (!instanceId) return;
		let cancelled = false;
		void api.getWorkbenchCardInstance(instanceId)
			.then((response) => {
				if (!cancelled) setEnvelope(response.instance.envelope);
			})
			.catch((reason: unknown) => {
				if (!cancelled) {
					setLoadError(reason instanceof Error ? reason.message : "Could not restore this card.");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [instanceId]);

	if (!instanceId || loadError) {
		return (
			<WorkbenchEmptyState
				title="Card unavailable"
				description={loadError ?? "This panel does not contain a supported card identity."}
			/>
		);
	}
	if (!envelope) {
		return <WorkbenchEmptyState title="Loading card" description="Restoring this card projection." />;
	}

	const handleAction = async (request: CardActionRequest) => {
		if (request.verb === "resource.open" || request.verb === "message.open") {
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
		if (request.verb === "message.archive" && request.resource?.kind === "message") {
			await api.archiveMail(request.resource.id);
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
			<div className="min-h-0 flex-1 overflow-auto p-4">
				<AdaptiveCardView
					envelope={envelope}
					onAction={handleAction}
					className="mx-auto max-w-3xl"
					headerActions={(
						<Button
							isIconOnly
							size="sm"
							variant="ghost"
							onPress={openPopout}
							aria-label="Pop out"
							className="h-7 min-h-7 w-7 min-w-7"
						>
							<ExternalLink className="h-3.5 w-3.5" />
						</Button>
					)}
				/>
			</div>
		</div>
	);
}
