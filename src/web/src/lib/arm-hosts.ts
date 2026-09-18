import type { AgentInfo } from "@/lib";

const HOST_FEATURES = new Set(["workspace-rpc", "repository-onboarding", "opencode-provider-auth"]);

export function getArmHostHarnesses(agent: AgentInfo | null | undefined): string[] {
	return [...new Set(agent?.capabilities.filter((capability) => !HOST_FEATURES.has(capability)) ?? [])].sort();
}

