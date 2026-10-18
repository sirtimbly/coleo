import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib";
import type { AgentInfo } from "@/lib";

interface ArmHostsState {
	agents: AgentInfo[];
	status: "loading" | "ready" | "error";
	refreshing: boolean;
	error: string | null;
}

interface ArmHostsResult extends ArmHostsState {
	refresh: () => Promise<void>;
}

/** Recheck host availability without reloading or resetting the spawn form. */
export function useArmHosts(watch: boolean): ArmHostsResult {
	const [state, setState] = useState<ArmHostsState>({
		agents: [], status: "loading", refreshing: false, error: null,
	});
	const requestVersion = useRef(0);
	const pending = useRef(false);
	const refresh = useCallback(async (): Promise<void> => {
		if (pending.current) return;
		pending.current = true;
		const version = ++requestVersion.current;
		setState((current) => ({ ...current, refreshing: true }));
		try {
			const { agents } = await api.listAgents();
			if (version !== requestVersion.current) return;
			setState({ agents, status: "ready", refreshing: false, error: null });
		} catch (error) {
			if (version !== requestVersion.current) return;
			setState((current) => ({
				...current, status: "error", refreshing: false,
				error: error instanceof Error ? error.message : "Unable to check arm hosts",
			}));
		} finally {
			if (version === requestVersion.current) pending.current = false;
		}
	}, []);

	useEffect(() => {
		const requests = requestVersion;
		void refresh();
		return () => { requests.current++; pending.current = false; };
	}, [refresh]);

	useEffect(() => {
		if (!watch) return;
		void refresh();
		const timer = window.setInterval(() => void refresh(), 10_000);
		return () => window.clearInterval(timer);
	}, [refresh, watch]);

	return { ...state, refresh };
}
