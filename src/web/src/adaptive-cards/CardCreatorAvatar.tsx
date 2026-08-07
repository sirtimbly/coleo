import { memo } from "react";

import { cn } from "@/lib";
import { getCardCreatorAvatarSource } from "./card-creators";

import type { CardCreator } from "../../../types/adaptive-cards";

export const CardCreatorAvatar = memo(function CardCreatorAvatar({
	creator,
	size = "md",
	className,
}: {
	creator: CardCreator;
	size?: "sm" | "md";
	className?: string;
}) {
	const source = getCardCreatorAvatarSource(creator);
	return (
		<img
			src={source}
			alt=""
			aria-hidden="true"
			className={cn(
				"shrink-0 border border-border bg-surface-secondary object-cover",
				creator.kind === "arm" ? "[image-rendering:pixelated]" : "",
				size === "sm" ? "h-6 w-6" : "h-8 w-8",
				className,
			)}
		/>
	);
});
