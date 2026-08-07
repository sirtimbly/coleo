/**
 * Shared Arm identity row used by fleet and viewer projections.
 *
 * Operational actions remain owned by each page while status, current work,
 * runtime location, usage, and selection presentation stay consistent.
 */

import type { ReactNode } from "react";

import { CollectionRow } from "@/design-system/CollectionRow";
import { WorkbenchStatusDot } from "@/design-system/WorkbenchSurface";
import { cn, type Arm } from "@/lib";

function statusTone(status: string): "neutral" | "accent" | "success" | "warning" | "danger" {
	if (status === "busy" || status === "running") return "accent";
	if (status === "idle") return "success";
	if (status === "starting" || status === "planning_blocked") return "warning";
	if (status === "error") return "danger";
	return "neutral";
}

function formatContextUsage(arm: Arm): string | null {
	if (!arm.contextBudget) return null;
	const percentage = Math.min((arm.currentContextUsed / arm.contextBudget) * 100, 100);
	return `${Math.round(percentage)}% context`;
}

export function ArmCollectionRow({
	arm,
	selected = false,
	attention = false,
	onOpen,
	actions,
	className,
}: {
	arm: Arm;
	selected?: boolean;
	attention?: boolean;
	onOpen: () => void;
	actions?: ReactNode;
	className?: string;
}) {
	const planningBlocked = arm.status === "planning_blocked";
	const currentWork = arm.currentBugTitle ?? arm.currentTaskSubject;
	const contextUsage = formatContextUsage(arm);
	const runtimeLocation = arm.host ?? arm.agentId;
	const metadata = [
		arm.harness,
		arm.provider,
		arm.model,
		runtimeLocation,
		arm.runtime?.state,
	].filter(Boolean).join(" · ");

	return (
		<CollectionRow
			title={
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate">{arm.name}</span>
					{arm.recoveryRequestedAt ? (
						<span className="shrink-0 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-warning">
							Recovery requested
						</span>
					) : null}
				</span>
			}
			description={
				planningBlocked ? (
					<span className="font-medium text-warning">
						Waiting for the Brain to finish the project planning gate
					</span>
				) : currentWork ? (
					<span>{arm.currentBugTitle ? "Bug" : "Task"} · {currentWork}</span>
				) : (
					<span className="italic">Waiting for the brain to assign work</span>
				)
			}
			meta={metadata}
			leading={
				<WorkbenchStatusDot
					tone={statusTone(arm.status)}
					label={arm.status}
				/>
			}
			trailing={
				<>
					{contextUsage ? <span className="hidden whitespace-nowrap lg:inline">{contextUsage}</span> : null}
					{arm.totalTokens !== undefined ? (
						<span className="hidden whitespace-nowrap xl:inline">
							{arm.totalTokens.toLocaleString()} tokens
						</span>
					) : null}
					{actions ? (
						<span
							className="flex items-center gap-1"
							onClick={(event) => event.stopPropagation()}
						>
							{actions}
						</span>
					) : null}
				</>
			}
			selected={selected}
			unread={attention}
			onOpen={onOpen}
			className={cn(attention && "bg-warning/5", className)}
		/>
	);
}
