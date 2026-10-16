import { Button } from "@heroui/react";
import { AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw, Server } from "lucide-react";
import { getArmHostHarnesses } from "@/lib/arm-hosts";
import type { ReactElement } from "react";
import type { AgentInfo } from "@/lib";

interface SpawnArmHostProps {
	agents: AgentInfo[];
	selectedId: string;
	status: "loading" | "ready" | "error";
	refreshing: boolean;
	error: string | null;
	disabled: boolean;
	onRefresh: () => void;
	onSelect: (agentId: string) => void;
}

export function SpawnArmHost({
	agents, selectedId, status, refreshing, error, disabled, onRefresh, onSelect,
}: SpawnArmHostProps): ReactElement {
	const selected = agents.find((agent) => agent.agentId === selectedId);
	const noHarnesses = selected && getArmHostHarnesses(selected).length === 0;
	const title = status === "loading" ? "Checking arm hosts…"
		: status === "error" ? "Could not check arm hosts"
		: !selected ? (selectedId ? "Selected arm host disconnected" : "No arm host connected")
		: noHarnesses ? "This host has no supported harnesses"
		: "Arm host connected";
	const blocked = status === "error" || (status === "ready" && (!selected || noHarnesses));
	const Icon = status === "loading" ? LoaderCircle : blocked ? AlertTriangle : CheckCircle2;

	return (
		<section aria-label="Arm host connection" className={`space-y-3 rounded-lg border p-4 ${blocked
			? "border-warning/50 bg-warning/10" : "border-border bg-surface-secondary/40"}`}>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2" role="status" aria-label="Host status">
					<Icon aria-hidden="true" className={`h-5 w-5 shrink-0 ${status === "loading"
						? "animate-spin motion-reduce:animate-none" : blocked ? "text-warning" : "text-success"}`} />
					<h3 className="font-semibold">{title}</h3>
				</div>
				<Button variant="secondary" size="sm" isDisabled={refreshing || disabled} onPress={onRefresh} className="gap-1.5">
					<RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />
					{refreshing ? "Checking hosts…" : "Check for hosts"}
				</Button>
			</div>
			{status === "loading" ? <p className="text-sm text-muted-foreground">Looking for a connected machine to run your arm.</p>
				: status === "error" ? (
					<div className="space-y-2 text-sm">
						<p>Host availability could not be verified. Check the workspace connection, then try again.</p>
						<p className="break-words text-muted-foreground">{error}</p>
					</div>
				) : !selected ? (
					<div className="space-y-3 text-sm">
						<p>Start an arm agent on the machine that will run your arm. Spawning is unavailable until a host connects.</p>
						<div className="rounded border border-border bg-surface p-3">
							<p className="mb-2 text-xs text-muted-foreground">Run in your project on that machine:</p>
							<code className="select-all font-mono">coleo agent start</code>
						</div>
						<p className="text-muted-foreground">Use the same Coleo connection settings as this workspace. This screen checks again every 10 seconds and keeps your form entries.</p>
					</div>
				) : noHarnesses ? (
					<p className="text-sm">Enable a supported harness on this host and restart its arm agent, or select another host.</p>
				) : <p className="text-sm text-muted-foreground">Your arm will run on <strong className="text-foreground">{selected.hostname}</strong>.</p>}
			{agents.length > 0 && status !== "error" && (
				<div>
					<label htmlFor="spawn-arm-host" className="mb-2 flex items-center gap-2 text-sm font-medium">
						<Server className="h-4 w-4" aria-hidden="true" /> Arm host
					</label>
					<select id="spawn-arm-host" value={selectedId} disabled={disabled} onChange={(event) => onSelect(event.target.value)}
						className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent">
						{!selected && <option value={selectedId}>Choose a connected host</option>}
						{agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.hostname} · {agent.agentId}</option>)}
					</select>
				</div>
			)}
		</section>
	);
}
