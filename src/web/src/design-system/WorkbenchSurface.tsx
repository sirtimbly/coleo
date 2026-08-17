/**
 * Compact structural surfaces for every workbench projection.
 *
 * These primitives replace page-specific card, section-header, toolbar, and
 * empty-state spacing while preserving the existing Coleo theme tokens.
 */

import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

import { cn } from "@/lib";

export function WorkbenchSurface({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("min-h-0 overflow-hidden border border-border bg-surface", className)}>
			{children}
		</section>
	);
}

export function WorkbenchHeader({
	title,
	description,
	icon,
	actions,
	className,
}: {
	title: ReactNode;
	description?: string;
	icon?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<header className={cn("flex min-h-14 items-center gap-3 border-b border-border px-4 py-2.5", className)}>
			{icon ? (
				<span className="flex h-8 w-8 shrink-0 items-center justify-center border border-border bg-surface-secondary text-muted-foreground">
					{icon}
				</span>
			) : null}
			<div className="min-w-0 flex-1">
				<h1 className="truncate text-sm font-semibold tracking-tight text-foreground">{title}</h1>
				{description ? (
					<p className="truncate text-xs text-muted-foreground">{description}</p>
				) : null}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
		</header>
	);
}

export function WorkbenchToolbar({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex min-h-11 flex-wrap items-center gap-2 border-b border-border bg-surface-secondary/35 px-3 py-2", className)}>
			{children}
		</div>
	);
}

export function WorkbenchEmptyState({
	title,
	description,
	action,
	icon,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
	icon?: ReactNode;
}) {
	return (
		<div className="flex h-full min-h-52 items-center justify-center p-6">
			<div className="max-w-sm text-center">
				<div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center border border-border bg-surface-secondary text-muted-foreground">
					{icon ?? <Inbox className="h-4 w-4" />}
				</div>
				<h2 className="text-sm font-semibold text-foreground">{title}</h2>
				{description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
				{action ? <div className="mt-4">{action}</div> : null}
			</div>
		</div>
	);
}

export function WorkbenchStatusDot({
	tone = "neutral",
	label,
}: {
	tone?: "neutral" | "accent" | "success" | "warning" | "danger";
	label?: string;
}) {
	const toneClass = {
		neutral: "bg-muted",
		accent: "bg-accent",
		success: "bg-success",
		warning: "bg-warning",
		danger: "bg-danger",
	}[tone];
	return (
		<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
			<span className={cn("h-1.5 w-1.5 rounded-full", toneClass)} aria-hidden />
			{label}
		</span>
	);
}
