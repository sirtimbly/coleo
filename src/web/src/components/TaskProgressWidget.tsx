import { useMemo } from "react";
import { CheckCircle2, Clock, Pause, XCircle, Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/Card";
import { ProgressBar } from "./ProgressBar";
import { cn } from "@/lib";

export interface TaskStats {
	total: number;
	byStatus: Record<string, number>;
	completionRate: number;
	active: number;
	blocked: number;
}

interface TaskProgressWidgetProps {
	stats?: TaskStats;
	isLoading?: boolean;
	className?: string;
	embedded?: boolean;
}

const STATUS_META: Record<string, { label: string; color: string; bg: string; icon: React.ComponentType<{ className?: string }> }> = {
	completed: { label: "Completed", color: "text-green-600", bg: "bg-green-500", icon: CheckCircle2 },
	in_progress: { label: "In Progress", color: "text-yellow-600", bg: "bg-yellow-500", icon: Loader2 },
	claimed: { label: "Claimed", color: "text-blue-600", bg: "bg-blue-500", icon: Clock },
	pending: { label: "Pending", color: "text-gray-500", bg: "bg-gray-400", icon: Clock },
	blocked: { label: "Blocked", color: "text-orange-600", bg: "bg-orange-500", icon: Pause },
	failed: { label: "Failed", color: "text-red-600", bg: "bg-red-500", icon: XCircle },
	completing: { label: "Completing", color: "text-emerald-600", bg: "bg-emerald-500", icon: CheckCircle2 },
};

export function TaskProgressWidget({ stats, isLoading, className, embedded = false }: TaskProgressWidgetProps) {
	const statusBreakdown = useMemo(() => {
		if (!stats) return [];
		return Object.entries(stats.byStatus)
			.map(([status, count]) => ({
				status,
				count,
				meta: STATUS_META[status] ?? { label: status, color: "text-gray-500", bg: "bg-gray-400", icon: Clock },
				percent: stats.total > 0 ? (count / stats.total) * 100 : 0,
			}))
			.sort((a, b) => b.count - a.count);
	}, [stats]);

	return (
		<Card className={cn(embedded && "rounded-none border-0 bg-transparent p-0", className)}>
			{!embedded ? <CardHeader>
				<CardTitle className="flex items-center justify-between">
					<span>Task Progress</span>
					<span className="text-xs font-normal text-muted-foreground">
						Real-time
					</span>
				</CardTitle>
			</CardHeader> : null}
			<CardContent>
				{isLoading || !stats ? (
					<div className="space-y-4">
						<div className="h-2 bg-secondary rounded animate-pulse" />
						<div className="grid grid-cols-2 gap-2">
							{[1, 2, 3, 4].map((i) => (
								<div key={i} className="h-8 bg-secondary rounded animate-pulse" />
							))}
						</div>
					</div>
				) : (
					<div className="space-y-4">
						{/* Overall completion */}
						<div>
							<div className="flex items-center justify-between mb-2">
								<span className="text-sm font-medium">Completion Rate</span>
								<span className="text-sm font-bold">{stats.completionRate}%</span>
							</div>
							<ProgressBar percent={stats.completionRate} size="sm" showLabel={false} />
						</div>

						{/* Status breakdown */}
						<div className="space-y-2">
							<p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
								Status Breakdown
							</p>
							{statusBreakdown.map(({ status, count, meta, percent }) => {
								const Icon = meta.icon;
								return (
									<div key={status} className="flex items-center gap-2">
										<Icon className={cn("h-4 w-4", meta.color)} />
										<div className="flex-1">
											<div className="flex items-center justify-between">
												<span className="text-sm">{meta.label}</span>
												<span className="text-xs text-muted-foreground">
													{count} ({Math.round(percent)}%)
												</span>
											</div>
											<div className="h-1.5 rounded-full overflow-hidden bg-secondary">
												<div
													className={cn("h-full rounded-full transition-all", meta.bg)}
													style={{ width: `${percent}%` }}
												/>
											</div>
										</div>
									</div>
								);
							})}
						</div>

						{/* Summary stats */}
						<div className="grid grid-cols-3 gap-2 pt-2 border-t border-border">
							<div className="text-center">
								<p className="text-lg font-bold">{stats.total}</p>
								<p className="text-xs text-muted-foreground">Total</p>
							</div>
							<div className="text-center">
								<p className="text-lg font-bold text-blue-600">{stats.active}</p>
								<p className="text-xs text-muted-foreground">Active</p>
							</div>
							<div className="text-center">
								<p className="text-lg font-bold text-orange-600">{stats.blocked}</p>
								<p className="text-xs text-muted-foreground">Blocked</p>
							</div>
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
