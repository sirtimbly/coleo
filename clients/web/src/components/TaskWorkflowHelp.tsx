import { Popover } from "@heroui/react";
import { CircleHelp, ExternalLink } from "lucide-react";

const STATUS_ROWS = [
	["Draft", "A human note that stays outside the runnable queue until it is moved to Pending."],
	["Pending", "Runnable and ordered in the normal task queue."],
	["Claimed / In progress", "Owned by an arm. These states are normally managed by the brain."],
	["Completing", "Work was reported complete and is waiting for validation or approval."],
	["Blocked", "Not runnable. A reason and scheduled recheck are required."],
	["Completed / Failed / Cancelled", "Terminal outcomes; move back to Pending to reopen work."],
] as const;

export function TaskWorkflowHelp() {
	return (
		<Popover>
			<Popover.Trigger
				aria-label="Explain task workflow"
				className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
			>
				<CircleHelp className="h-4 w-4" />
			</Popover.Trigger>
			<Popover.Content placement="bottom end" className="w-[520px] max-w-[calc(100vw-2rem)]">
				<Popover.Dialog className="max-h-[min(520px,calc(100vh-2rem))] overflow-auto outline-none">
					<div className="space-y-4 px-1 py-1">
						<div>
							<div className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
								Task Workflow
							</div>
							<p className="mt-1 text-sm leading-5 text-muted-foreground">
								Statuses control whether the brain can assign work; they are not only labels.
							</p>
						</div>

						<div className="space-y-2">
							{STATUS_ROWS.map(([label, detail]) => (
								<div key={label} className="rounded-md border border-border bg-surface-secondary/35 px-3 py-2">
									<div className="text-xs font-semibold text-foreground">{label}</div>
									<div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>
								</div>
							))}
						</div>

						<div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs leading-5 text-muted-foreground">
							<strong className="text-foreground">Blocked tasks are reviewed in order.</strong> An arm researches whether the blocker cleared, the task is obsolete, or a human decision is needed. A human reply in Discussions or on a task email makes that task eligible for immediate review.
						</div>

						<a
							href="https://github.com/sirtimbly/coleo/blob/master/docs/guides/task-workflow.md"
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
						>
							Read the task workflow guide
							<ExternalLink className="h-3 w-3" />
						</a>
					</div>
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
}
