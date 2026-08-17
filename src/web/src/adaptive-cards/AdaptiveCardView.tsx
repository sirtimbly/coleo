import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib";
import { CardCreatorAvatar } from "./CardCreatorAvatar";
import { useCardPresentation } from "./card-presentation";
import { CardViewSettings } from "./CardViewSettings";
import { getCardTemplate, isCardActionAllowed } from "./catalog";
import { expandCardTemplate } from "./expand-template";
import { ADAPTIVE_CARDS_ENABLED } from "./feature-flags";
import { COLEO_CARD_HOST_CONFIG } from "./host-config";

import type {
	CardActionRequest,
	CardEnvelope,
	CardJsonObject,
} from "../../../types/adaptive-cards";
import type { CardPresentationMode } from "./card-presentation";
import type { ReactNode } from "react";

export interface AdaptiveCardViewProps {
	envelope: CardEnvelope;
	onAction?: (request: CardActionRequest) => void | Promise<void>;
	className?: string;
	headerActions?: ReactNode;
	footerActions?: ReactNode;
	allCardsDefault?: CardPresentationMode;
	presentationMode?: CardPresentationMode;
}

export function AdaptiveCardView({
	envelope,
	onAction,
	className,
	headerActions,
	footerActions,
	allCardsDefault,
	presentationMode,
}: AdaptiveCardViewProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const onActionRef = useRef(onAction);
	const [error, setError] = useState<string | null>(null);
	const [technicalDetailsOpen, setTechnicalDetailsOpen] = useState(false);
	const settings = useCardPresentation(
		envelope.id,
		envelope.presentation.compact ? "compact" : "detail",
		allCardsDefault,
	);
	const configurable = envelope.presentation.surface !== "editor" && presentationMode === undefined;
	const mode = envelope.presentation.surface === "editor"
		? "detail"
		: presentationMode ?? settings.mode;
	const hasTechnicalDetails = Array.isArray(envelope.data.technicalFacts) && envelope.data.technicalFacts.length > 0;
	onActionRef.current = onAction;

	useEffect(() => {
		let cancelled = false;
		const host = hostRef.current;
		if (!host) return;
		host.replaceChildren();
		setError(null);

		const render = async () => {
			if (!ADAPTIVE_CARDS_ENABLED) {
				throw new Error("Adaptive Cards are disabled for this deployment.");
			}
			if (envelope.schemaVersion !== "1.5") {
				throw new Error(`Unsupported card schema ${envelope.schemaVersion}`);
			}
			const payload = getCardTemplate(envelope.template.id, envelope.template.version);
			if (!payload) {
				throw new Error(
					`Unknown template ${envelope.template.id}@${envelope.template.version}`,
				);
			}

			const cards = await import("adaptivecards/dist/adaptivecards.js");
			if (cancelled) return;
			const data: CardJsonObject = {
				...envelope.data,
				facts: mode === "compact" ? [] : envelope.data.facts,
				description: mode === "compact" ? null : envelope.data.description,
				timestampLabel: mode === "compact" ? null : envelope.data.timestampLabel,
				canArchive: envelope.data.canArchive === true,
				showAttentionActions:
					mode === "detail" && envelope.data.requiresAction === true,
				showTechnicalDetails: mode === "detail" && technicalDetailsOpen,
				summaryMaxLines: mode === "compact" ? 2 : 0,
				previewMaxLines: mode === "compact" ? 2 : 0,
			};
			const expanded = expandCardTemplate(payload, data) as CardJsonObject;
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
					expectedResourceVersion: typeof data.expectedResourceVersion === "string"
						? data.expectedResourceVersion
						: undefined,
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
	}, [envelope, mode, technicalDetailsOpen]);

	return (
		<div
			data-card-template={`${envelope.template.id}@${envelope.template.version}`}
			data-card-presentation={mode}
			data-card-creator={envelope.creator
				? `${envelope.creator.kind}:${envelope.creator.id}`
				: undefined}
			className={cn(
				"min-w-0 overflow-hidden rounded-md border border-border bg-card",
				className,
			)}
		>
			<div className="flex min-h-10 items-center gap-2 border-b border-border/70 px-3 py-1.5">
				{envelope.creator ? (
					<>
						<CardCreatorAvatar
							creator={envelope.creator}
							size={mode === "compact" ? "sm" : "md"}
						/>
						<div className="min-w-0 flex-1">
							<p className="truncate text-xs font-semibold text-foreground">
								{envelope.creator.displayName}
							</p>
						</div>
					</>
				) : (
					<div className="min-w-0 flex-1" />
				)}
				<div className="ml-auto flex shrink-0 items-center gap-1">
					{headerActions}
					{configurable ? (
						<CardViewSettings
							mode={mode}
							globalMode={settings.globalMode}
							hasOverride={settings.hasOverride}
							onCardModeChange={settings.setForCard}
							onClearCardMode={settings.clearForCard}
							onAllModeChange={settings.setForAll}
						/>
					) : null}
				</div>
			</div>
			{error ? (
				<div role="alert" className="border border-danger/30 bg-danger/10 p-4 text-sm">
					<p className="font-semibold">Card unavailable</p>
					<p className="mt-1 text-muted-foreground">{error}</p>
					<p className="mt-3 font-medium">
						{String(envelope.data.title ?? envelope.presentation.title ?? envelope.id)}
					</p>
					<p className="mt-1 text-muted-foreground">
						{String(envelope.data.summary ?? "")}
					</p>
				</div>
			) : null}
			<div
				ref={hostRef}
				className={cn("adaptive-card-host", error ? "hidden" : "")}
			/>
			{footerActions || (hasTechnicalDetails && mode === "detail") ? (
				<div className={cn(
					"min-h-10 items-center gap-1 border-t border-border/70 px-3 py-1.5",
					hasTechnicalDetails && mode === "detail"
						? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
						: "flex flex-wrap",
				)}>
					<div className="flex min-w-0 flex-wrap items-center gap-1">{footerActions}</div>
					{hasTechnicalDetails && mode === "detail" ? (
						<Button
							size="sm"
							variant="ghost"
							aria-label={technicalDetailsOpen ? "Hide details" : "More details"}
							aria-expanded={technicalDetailsOpen}
							onPress={() => setTechnicalDetailsOpen((open) => !open)}
							className="h-7 min-h-7 text-[0.68rem] !font-normal"
						>
							{technicalDetailsOpen ? "Hide details" : "More details"}
							{technicalDetailsOpen ? (
								<ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
							) : (
								<ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
							)}
						</Button>
					) : null}
					{hasTechnicalDetails && mode === "detail" ? <span aria-hidden="true" /> : null}
				</div>
			) : null}
		</div>
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
		<div ref={boundaryRef} className="min-h-24">
			{visible ? <AdaptiveCardView {...props} /> : null}
		</div>
	);
}
