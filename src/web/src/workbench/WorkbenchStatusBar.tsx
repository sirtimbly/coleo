/**
 * Persistent workbench status bar.
 *
 * It exposes shell-level state—live connection, active/blocked runs, and the
 * current portable profile—without duplicating dashboard content.
 */

import { useQuery } from "@tanstack/react-query";
import { Activity, CircleUserRound, Radio } from "lucide-react";

import { api } from "@/lib";

import { useLiveProjections } from "./live-projections";
import { useWorkbenchProfile } from "./profile-context";

export function WorkbenchStatusBar({
	onOpenProcesses,
	onOpenProfiles,
}: {
	onOpenProcesses: () => void;
	onOpenProfiles: () => void;
}) {
	const connection = useLiveProjections();
	const { profile } = useWorkbenchProfile();
	const runsQuery = useQuery({
		queryKey: ["runs", "status-bar"],
		queryFn: () => api.listRuns({ limit: 250 }),
		refetchInterval: 30_000,
	});
	const runs = runsQuery.data?.runs ?? [];
	const active = runs.filter((run) => !run.endedAt);
	const blocked = active.filter((run) => run.status === "blocked");

	return (
		<footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface-secondary px-3 text-[0.68rem] text-muted-foreground">
			<span className="inline-flex items-center gap-1.5" title="Live projection connection">
				<Radio className={connection.authenticated ? "h-3 w-3 text-success" : "h-3 w-3 text-warning"} />
				{connection.authenticated ? "Live" : connection.connected ? "Authenticating" : "Offline"}
			</span>
			<button
				type="button"
				onClick={onOpenProcesses}
				className="inline-flex items-center gap-1.5 hover:text-foreground"
				title="Open process monitor"
			>
				<Activity className="h-3 w-3" />
				{active.length} active
				{blocked.length > 0 ? <span className="text-warning">· {blocked.length} blocked</span> : null}
			</button>
			<button
				type="button"
				onClick={onOpenProfiles}
				className="ml-auto inline-flex items-center gap-1.5 hover:text-foreground"
				title="Open workbench profile settings"
			>
				<CircleUserRound className="h-3 w-3" />
				{profile?.name ?? "Local workspace"}
			</button>
		</footer>
	);
}
