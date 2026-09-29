import type { CSSProperties, ReactNode } from "react";
import { AnimatePresence, LazyMotion, m, useReducedMotion } from "framer-motion";

import { cn } from "@/lib";

import type { CardColumnCount } from "./collection-display";
import type { CardPresentationMode } from "@/adaptive-cards/card-presentation";

import "./adaptive-card-collection.css";

const loadMotionFeatures = () => import("./adaptive-card-motion-features").then((module) => module.default);
const CARD_TRANSITION = { duration: 0.18, ease: "easeOut" } as const;

interface CollectionGridStyle extends CSSProperties {
	"--collection-card-columns": CardColumnCount;
}

export function AdaptiveCardCollection<T>({
	projectedItems,
	columns,
	presentation,
	getKey,
	renderCard,
	className,
}: {
	/** Rows after React-owned filtering and sorting. This component only lays them out. */
	projectedItems: readonly T[];
	columns: CardColumnCount;
	presentation: CardPresentationMode;
	getKey: (item: T) => string;
	renderCard: (item: T, presentation: CardPresentationMode) => ReactNode;
	className?: string;
}) {
	const shouldReduceMotion = useReducedMotion();
	const transition = shouldReduceMotion ? { duration: 0 } : CARD_TRANSITION;

	return (
		<div className={cn("coleo-adaptive-card-collection h-full overflow-auto p-3", className)}>
			<LazyMotion features={loadMotionFeatures} strict>
				<div
					className="coleo-adaptive-card-grid"
					style={{ "--collection-card-columns": columns } as CollectionGridStyle}
				>
					<AnimatePresence initial={false}>
						{projectedItems.map((item) => (
							<m.article
								key={getKey(item)}
								layout={shouldReduceMotion ? false : "position"}
								initial={shouldReduceMotion ? false : { opacity: 0, y: 4 }}
								animate={{ opacity: 1, y: 0 }}
								exit={shouldReduceMotion ? undefined : { opacity: 0, y: -4 }}
								transition={transition}
								className="min-w-0 [content-visibility:auto] [contain-intrinsic-size:auto_14rem]"
							>
								{renderCard(item, presentation)}
							</m.article>
						))}
					</AnimatePresence>
				</div>
			</LazyMotion>
		</div>
	);
}
