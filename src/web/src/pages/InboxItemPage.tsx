import { Button } from "@heroui/react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AdaptiveCardView } from "@/adaptive-cards/AdaptiveCardView";
import { createPersistedCardRoute } from "@/adaptive-cards/persisted-card-route";
import { presentInboxItem } from "@/adaptive-cards/presenters";
import { WorkbenchEmptyState } from "@/design-system/WorkbenchSurface";
import { api, isJsonObject } from "@/lib/api";
import { useProjectionSignal } from "@/workbench/live-projections";
import { useWorkspaceOpenRoute } from "@/workspace/route-context";
import { creatorForInboxItem } from "./inbox-item-projection";
import { inboxItemQueryKey, loadInboxItem } from "./load-inbox-item";
import type { CardActionRequest } from "../../../types/adaptive-cards";

// A detail screen owns one record. It never mounts the inbox collection or its subscriptions.
export function InboxItemPage({ itemId, sequence }: { itemId: string; sequence: string | null }) {
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const [actionError, setActionError] = useState<string | null>(null);
	const { data: item, error: loadError, refetch } = useQuery({
		queryKey: inboxItemQueryKey(itemId),
		queryFn: () => loadInboxItem(itemId, sequence ?? undefined),
		staleTime: 0,
		retry: false,
	});
	useProjectionSignal((signal) => {
		const data = signal.data;
		if (!isJsonObject(data)) return;
		const itemKeys = data.itemKeys;
		if (data.itemKey === itemId || (Array.isArray(itemKeys) && itemKeys.includes(itemId))) {
			void refetch();
		} else if ((signal.channel === "tasks" && itemId === `task:${data.taskId ?? data.id}`)
			|| (signal.channel === "bugs" && itemId === `bug:${data.bugId ?? data.id}`)
			|| (signal.channel === "brain" && itemId === "brain:planning-gate")) {
			void refetch();
		}
	});
	const error = actionError ?? loadError?.message ?? null;

	if (!item) return <WorkbenchEmptyState title={error ? "Inbox item unavailable" : "Loading inbox item"}
		description={error ?? "Loading this record."} />;

	const envelope = presentInboxItem(item.item, {
		surface: "detail", targetRoute: item.targetRoute, creator: creatorForInboxItem(item),
		facts: item.statusReport ? [
			{ label: "Arm", value: item.statusReport.armId },
			{ label: "Task", value: item.statusReport.taskId },
			{ label: "Status", value: item.statusReport.status.replaceAll("_", " ") },
		] : [],
	});
	const handleAction = async (request: CardActionRequest) => {
		try {
			if (request.verb === "resource.open" && item.targetRoute) {
				openWorkspaceRoute(item.targetRoute, "focus");
				return;
			}
			await api.executeWorkbenchCardAction(request);
			setActionError(null);
			await refetch();
		} catch (reason) {
			setActionError(reason instanceof Error ? reason.message : "Could not update this item.");
		}
	};
	return <div className="h-full min-h-0 overflow-auto bg-background p-5">
		{error && <p role="alert">{error}</p>}
		<AdaptiveCardView envelope={envelope} onAction={handleAction} className="mx-auto max-w-4xl"
			headerActions={<Button size="sm" variant="ghost" onPress={() => {
				void createPersistedCardRoute({ ...envelope, presentation: { ...envelope.presentation, surface: "panel" } })
					.then((route) => openWorkspaceRoute(route, "tab"))
					.catch((reason: unknown) => setActionError(reason instanceof Error ? reason.message : "Could not open card."));
			}}>Open card</Button>} />
	</div>;
}
