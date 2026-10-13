import type { Arm } from "@/lib";

export type ArmCollectionScope = "all" | "attention" | "working" | "waiting";

export const ARM_COLLECTION_SCOPE_LABELS: Record<ArmCollectionScope, string> = {
	all: "All arms",
	attention: "Needs attention",
	working: "Working",
	waiting: "Waiting",
};

export function armNeedsAttention(arm: Arm): boolean {
	const runtimeState = arm.runtime?.state;
	return (
		arm.status === "error" ||
		arm.status === "stopped" ||
		runtimeState === "hung" ||
		runtimeState === "recoverable" ||
		(runtimeState === "stopped" && arm.runtime?.canRecover === true) ||
		(arm.status === "starting" && !arm.runtime?.hasRuntime)
	);
}

export function armMatchesCollectionScope(arm: Arm, scope: ArmCollectionScope): boolean {
	if (scope === "all") return true;
	if (scope === "attention") return armNeedsAttention(arm);
	if (scope === "working") return arm.status === "busy" || arm.status === "running";
	return !armNeedsAttention(arm) && arm.status !== "busy" && arm.status !== "running";
}

export function armMatchesSearch(arm: Arm, searchText: string): boolean {
	const query = searchText.trim().toLowerCase();
	if (!query) return true;
	return [
		arm.name,
		arm.id,
		arm.domain,
		arm.status,
		arm.harness,
		arm.provider,
		arm.model,
		arm.host,
		arm.agentId,
		arm.runtime?.state,
		arm.currentTaskSubject,
		arm.currentBugTitle,
	].some((value) => value?.toLowerCase().includes(query));
}
