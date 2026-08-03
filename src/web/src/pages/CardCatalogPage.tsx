import { useMemo, useState } from "react";

import { AdaptiveCardView } from "@/adaptive-cards/AdaptiveCardView";
import {
	presentInboxItem,
	presentMessage,
	presentResourceDetail,
	presentResourceEditor,
} from "@/adaptive-cards/presenters";
import { WorkbenchHeader } from "@/design-system/WorkbenchSurface";

import type { CardActionRequest, CardEnvelope } from "../../../types/adaptive-cards";

export function CardCatalogPage() {
	const [lastAction, setLastAction] = useState<CardActionRequest | null>(null);
	const samples = useMemo<Array<{ label: string; envelope: CardEnvelope }>>(() => [
		{
			label: "Attention event",
			envelope: presentInboxItem({
				id: "preview:event",
				kind: "system",
				title: "Task needs a decision",
				summary: "The Arm is blocked and has requested human input.",
				timestamp: new Date().toISOString(),
				source: "Card catalog",
				unread: true,
				requiresAction: true,
				severity: "warning",
			}, {
				surface: "detail",
				facts: [
					{ label: "Task", value: "task-preview" },
					{ label: "Arm", value: "frontend-preview" },
				],
			}),
		},
		{
			label: "Message",
			envelope: presentMessage({
				id: "preview-message",
				from: "Coleo Brain",
				subject: "Plan review is ready",
				preview: "The proposed work has been decomposed into reviewable tasks.",
				timestamp: new Date().toISOString(),
			}),
		},
		{
			label: "Resource detail",
			envelope: presentResourceDetail({
				id: "task-preview",
				kind: "task",
				title: "Add a semantic activity presenter",
				description: "Keep raw diagnostics while standardizing the readable event summary.",
				facts: [
					{ label: "Status", value: "In progress" },
					{ label: "Priority", value: "High" },
				],
			}),
		},
		{
			label: "Resource editor",
			envelope: presentResourceEditor({
				id: "task-preview",
				kind: "task",
				title: "Add a semantic activity presenter",
				description: "Preview input collection without executing a domain mutation.",
				resourceVersion: "preview",
			}),
		},
	], []);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<WorkbenchHeader
				title="Adaptive Card catalog"
				description="Developer preview for trusted templates, surfaces, and action payloads"
			/>
			<div className="min-h-0 flex-1 overflow-auto p-5">
				<div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-2">
					{samples.map(({ label, envelope }) => (
						<section key={envelope.id} className="min-w-0">
							<h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{label} · {envelope.template.id}@{envelope.template.version}
							</h2>
							<AdaptiveCardView envelope={envelope} onAction={setLastAction} />
						</section>
					))}
				</div>
				{lastAction ? (
					<pre className="mx-auto mt-6 max-w-6xl overflow-auto border border-border bg-surface p-4 text-xs">
						{JSON.stringify(lastAction, null, 2)}
					</pre>
				) : null}
			</div>
		</div>
	);
}
