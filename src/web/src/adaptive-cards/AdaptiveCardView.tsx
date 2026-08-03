import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib";
import { getCardTemplate, isCardActionAllowed } from "./catalog";
import { COLEO_CARD_HOST_CONFIG } from "./host-config";

import type {
	CardActionRequest,
	CardEnvelope,
	CardJsonObject,
} from "../../../types/adaptive-cards";

export interface AdaptiveCardViewProps {
	envelope: CardEnvelope;
	onAction?: (request: CardActionRequest) => void | Promise<void>;
	className?: string;
}

export function AdaptiveCardView({
	envelope,
	onAction,
	className,
}: AdaptiveCardViewProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const onActionRef = useRef(onAction);
	const [error, setError] = useState<string | null>(null);
	onActionRef.current = onAction;

	useEffect(() => {
		let cancelled = false;
		const host = hostRef.current;
		if (!host) return;
		host.replaceChildren();
		setError(null);

		const render = async () => {
			if (envelope.schemaVersion !== "1.5") {
				throw new Error(`Unsupported card schema ${envelope.schemaVersion}`);
			}
			const payload = getCardTemplate(envelope.template.id, envelope.template.version);
			if (!payload) {
				throw new Error(
					`Unknown template ${envelope.template.id}@${envelope.template.version}`,
				);
			}

			const [cards, templating] = await Promise.all([
				import("adaptivecards/dist/adaptivecards.js"),
				import("adaptivecards-templating/dist/adaptivecards-templating.js"),
			]);
			if (cancelled) return;
			const template = new templating.Template(payload);
			const expanded = template.expand({ $root: envelope.data }) as CardJsonObject;
			const card = new cards.AdaptiveCard();
			card.hostConfig = new cards.HostConfig(COLEO_CARD_HOST_CONFIG);
			card.onAnchorClicked = () => true;
			card.onExecuteAction = (action) => {
				if (action.getJsonTypeName() !== "Action.Execute") return;
				const verb = action.verb;
				if (
					!verb ||
					!onActionRef.current ||
					!isCardActionAllowed(envelope.template.id, envelope.template.version, verb)
				) return;
				const data = action.data && typeof action.data === "object"
					? action.data as CardJsonObject
					: {};
				const actionId = typeof data.actionId === "string" ? data.actionId : verb;
				void onActionRef.current({
					envelopeId: envelope.id,
					template: envelope.template,
					actionId,
					verb,
					resource: envelope.resource,
					inputs: data,
					clientActionId: crypto.randomUUID(),
				});
			};
			card.parse(expanded);
			const element = card.render();
			if (!cancelled && element) host.replaceChildren(element);
		};

		void render().catch((reason: unknown) => {
			if (!cancelled) {
				setError(reason instanceof Error ? reason.message : "Could not render this card.");
			}
		});
		return () => {
			cancelled = true;
			host.replaceChildren();
		};
	}, [envelope]);

	if (error) {
		return (
			<div role="alert" className={cn("border border-danger/30 bg-danger/10 p-4 text-sm", className)}>
				<p className="font-semibold">Card unavailable</p>
				<p className="mt-1 text-muted-foreground">{error}</p>
				<p className="mt-3 font-medium">{String(envelope.data.title ?? envelope.presentation.title ?? envelope.id)}</p>
				<p className="mt-1 text-muted-foreground">{String(envelope.data.summary ?? "")}</p>
			</div>
		);
	}

	return (
		<div
			ref={hostRef}
			data-card-template={`${envelope.template.id}@${envelope.template.version}`}
			className={cn(
				"adaptive-card-host min-w-0 overflow-hidden border border-border bg-card",
				className,
			)}
		/>
	);
}

export function DeferredAdaptiveCardView(props: AdaptiveCardViewProps) {
	const boundaryRef = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const boundary = boundaryRef.current;
		if (!boundary || visible) return;
		if (!("IntersectionObserver" in window)) {
			setVisible(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setVisible(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "400px 0px" },
		);
		observer.observe(boundary);
		return () => observer.disconnect();
	}, [visible]);

	return (
		<div ref={boundaryRef} className={cn("min-h-24", props.className)}>
			{visible ? <AdaptiveCardView {...props} className={undefined} /> : null}
		</div>
	);
}
