/**
 * Unified list-row presentation for inboxes, timelines, process monitors, and
 * compact dashboard collections.
 */

import type { KeyboardEvent, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib";

export function CollectionRow({
	title,
	description,
	meta,
	leading,
	trailing,
	unread = false,
	selected = false,
	onOpen,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	meta?: ReactNode;
	leading?: ReactNode;
	trailing?: ReactNode;
	unread?: boolean;
	selected?: boolean;
	onOpen?: () => void;
	className?: string;
}) {
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!onOpen || (event.key !== "Enter" && event.key !== " ")) return;
		event.preventDefault();
		onOpen();
	};

	return (
		<div
			role={onOpen ? "button" : undefined}
			tabIndex={onOpen ? 0 : undefined}
			onClick={onOpen}
			onKeyDown={onKeyDown}
			className={cn(
				"group grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-2.5 outline-none",
				onOpen && "cursor-pointer hover:bg-surface-secondary/60 focus-visible:bg-surface-secondary",
				selected && "bg-accent/8",
				className,
			)}
		>
			<div className="flex min-w-3 items-center justify-center">
				{leading ?? (
					<span
						className={cn("h-1.5 w-1.5 rounded-full", unread ? "bg-accent" : "bg-border")}
						aria-label={unread ? "Unread" : undefined}
					/>
				)}
			</div>
			<div className="min-w-0">
				<div className={cn("truncate text-sm text-foreground", unread ? "font-semibold" : "font-medium")}>
					{title}
				</div>
				{description ? (
					<div className="mt-0.5 truncate text-xs text-muted-foreground">{description}</div>
				) : null}
				{meta ? <div className="mt-1 text-[0.68rem] text-muted-foreground/80">{meta}</div> : null}
			</div>
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				{trailing}
				{onOpen ? <ChevronRight className="h-3.5 w-3.5 opacity-40 group-hover:opacity-80" /> : null}
			</div>
		</div>
	);
}
