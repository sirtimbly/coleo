import { isSupportedHarness } from "../../../../server/src/harness/supported";
import type { AgentInfo } from "@/lib";

export function getArmHostHarnesses(agent: AgentInfo | null | undefined): string[] {
	return [...new Set(agent?.capabilities.filter(isSupportedHarness) ?? [])];
}
