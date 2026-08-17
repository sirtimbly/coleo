import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib";

import type { CardColumnCount } from "./collection-display";
import type { CardPresentationMode } from "@/adaptive-cards/card-presentation";

import "./adaptive-card-collection.css";

interface CollectionGridStyle extends CSSProperties {
	"--collection-card-columns": CardColumnCount;
}

export function AdaptiveCardCollection<T>({
	items,
	columns,
	presentation,
	getKey,
	renderCard,
	className,
}: {
	items: T[];
	columns: CardColumnCount;
	presentation: CardPresentationMode;
	getKey: (item: T) => string;
	renderCard: (item: T, presentation: CardPresentationMode) => ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("coleo-adaptive-card-collection h-full overflow-auto p-3", className)}>
			<div
				className="coleo-adaptive-card-grid"
				style={{ "--collection-card-columns": columns } as CollectionGridStyle}
			>
				{items.map((item) => (
					<article key={getKey(item)} className="min-w-0 [content-visibility:auto] [contain-intrinsic-size:auto_14rem]">
						{renderCard(item, presentation)}
					</article>
				))}
			</div>
		</div>
	);
}
