/**
 * Active workbench profile and saved-view state.
 *
 * Profiles are portable UI identities. The provider keeps the current profile
 * and its saved projections/layouts available to every Golden Layout panel,
 * while all persistence is delegated to the workbench API.
 */

import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib";

import type {
	ViewDefinition,
	ViewPreferences,
	WorkbenchProfile,
	WorkspaceLayoutRecord,
} from "./types";
import type { JsonObject } from "@/lib/api";

const PROFILE_STORAGE_KEY = "coleo:workbench-profile";
type WorkbenchBootstrap = Awaited<ReturnType<typeof api.getWorkbenchBootstrap>>;

interface WorkbenchProfileContextValue {
	profileId: string;
	profile: WorkbenchProfile | null;
	views: ViewDefinition[];
	layouts: WorkspaceLayoutRecord[];
	isLoading: boolean;
	setActiveProfile: (profileId: string) => void;
	updateProfilePreferences: (
		updater: (current: JsonObject) => JsonObject,
	) => Promise<WorkbenchProfile>;
	saveView: (view: ViewDefinition) => Promise<ViewDefinition>;
	deleteView: (viewId: string) => Promise<void>;
	refresh: () => Promise<void>;
}

const WorkbenchProfileContext = createContext<WorkbenchProfileContextValue | null>(null);

function readInitialProfileId(): string {
	if (typeof window === "undefined") return "local";
	try {
		return window.localStorage.getItem(PROFILE_STORAGE_KEY) ?? "local";
	} catch {
		return "local";
	}
}

export function WorkbenchProfileProvider({ children }: { children: ReactNode }) {
	const [profileId, setProfileId] = useState(readInitialProfileId);
	const queryClient = useQueryClient();
	const bootstrapQuery = useQuery({
		queryKey: ["workbench", "bootstrap", profileId],
		queryFn: () => api.getWorkbenchBootstrap(profileId),
		retry: (failureCount, error) => profileId !== "local" && failureCount < 1 && !error.message.includes("404"),
	});

	const viewWrites = useRef(new Map<string, Promise<ViewDefinition>>());
	const saveView = useCallback((view: ViewDefinition): Promise<ViewDefinition> => {
		const key = JSON.stringify([view.profileId, view.id]);
		const previous = viewWrites.current.get(key);
		const write = async () => {
			const cached = queryClient.getQueryData<WorkbenchBootstrap>(["workbench", "bootstrap", view.profileId]);
			const existing = cached?.views.some((item) => item.id === view.id);
			const saved = existing
				? (await api.saveWorkbenchView(view.id, view)).view
				: (await api.createWorkbenchView({ ...view, id: view.id })).view;
			queryClient.setQueryData(
				["workbench", "bootstrap", view.profileId],
				(current: WorkbenchBootstrap | undefined) => {
					if (!current) return current;
					const exists = current.views.some((item) => item.id === view.id);
					return {
						...current,
						views: exists
							? current.views.map((item) => item.id === view.id ? saved : item)
							: [...current.views, saved],
					};
				},
			);
			return saved;
		};
		const pending = previous ? previous.catch(() => undefined).then(write) : write();
		viewWrites.current.set(key, pending);
		const cleanup = () => {
			if (viewWrites.current.get(key) === pending) viewWrites.current.delete(key);
		};
		void pending.then(cleanup, cleanup);
		return pending;
	}, [queryClient]);

	const deleteMutation = useMutation({
		mutationFn: (viewId: string) => api.deleteWorkbenchView(viewId),
		onSuccess: (_result, viewId) => {
			queryClient.setQueryData(
				["workbench", "bootstrap", profileId],
				(current: typeof bootstrapQuery.data | undefined) => current
					? { ...current, views: current.views.filter((view) => view.id !== viewId) }
					: current,
			);
		},
	});

	const setActiveProfile = useCallback((nextProfileId: string) => {
		setProfileId(nextProfileId);
		try {
			window.localStorage.setItem(PROFILE_STORAGE_KEY, nextProfileId);
		} catch {
			// The server remains authoritative when browser storage is unavailable.
		}
	}, []);

	const refresh = useCallback(async () => {
		await bootstrapQuery.refetch();
	}, [bootstrapQuery]);
	const updateProfilePreferences = useCallback(async (
		updater: (current: JsonObject) => JsonObject,
	) => {
		const activeProfile = bootstrapQuery.data?.profile;
		if (!activeProfile) throw new Error("No active workbench profile is available");
		const capturedProfileId = activeProfile.id;
		const preferences = updater(activeProfile.preferences);
		const { profile } = await api.updateWorkbenchProfile(capturedProfileId, { preferences });
		queryClient.setQueryData(
			["workbench", "bootstrap", capturedProfileId],
			(current: typeof bootstrapQuery.data | undefined) => current
				? { ...current, profile }
				: current,
		);
		return profile;
	}, [bootstrapQuery, queryClient]);

	const value = useMemo<WorkbenchProfileContextValue>(() => ({
		profileId,
		profile: bootstrapQuery.data?.profile ?? null,
		views: bootstrapQuery.data?.views ?? [],
		layouts: bootstrapQuery.data?.layouts ?? [],
		isLoading: bootstrapQuery.isLoading,
		setActiveProfile,
		updateProfilePreferences,
		saveView,
		deleteView: async (viewId) => {
			await deleteMutation.mutateAsync(viewId);
		},
		refresh,
	}), [
		profileId,
		bootstrapQuery.data,
		bootstrapQuery.isLoading,
		deleteMutation,
		refresh,
		saveView,
		setActiveProfile,
		updateProfilePreferences,
	]);

	return (
		<WorkbenchProfileContext.Provider value={value}>
			{children}
		</WorkbenchProfileContext.Provider>
	);
}

export function useWorkbenchProfile(): WorkbenchProfileContextValue {
	const context = useContext(WorkbenchProfileContext);
	if (!context) throw new Error("useWorkbenchProfile must be used inside WorkbenchProfileProvider");
	return context;
}

export function useSavedView(
	viewId: string,
	defaults: Omit<ViewDefinition, "profileId" | "key" | "createdAt" | "updatedAt" | "version">,
) {
	const context = useWorkbenchProfile();
	const activeProfileId = context.profileId;
	const ownSaved = context.views.find((view) =>
		(view.key === viewId || view.id === viewId) && view.profileId === activeProfileId
	);
	const sharedSaved = context.views.find((view) =>
		(view.key === viewId || view.id === viewId) && view.shared
	);
	const saved = ownSaved ?? sharedSaved;
	const defaultsRef = useRef({ viewId, defaults });
	if (defaultsRef.current.viewId !== viewId) defaultsRef.current = { viewId, defaults };
	const view = useMemo<ViewDefinition>(() => {
		if (saved) return saved;
		const now = new Date().toISOString();
		return {
			...defaultsRef.current.defaults,
			id: `view:${activeProfileId}:${viewId}`,
			key: viewId,
			profileId: activeProfileId,
			version: 1,
			createdAt: now,
			updatedAt: now,
		};
	}, [activeProfileId, saved, viewId]);

	const saveDefinition = useCallback(async (definition: ViewDefinition) => {
		return context.saveView({
			...definition,
			id: ownSaved?.id ?? `view:${activeProfileId}:${viewId}`,
			key: viewId,
			profileId: activeProfileId,
			updatedAt: new Date().toISOString(),
		});
	}, [activeProfileId, context, ownSaved?.id, viewId]);

	const savePreferences = useCallback(async (preferences: ViewPreferences) => {
		await saveDefinition({ ...view, preferences });
	}, [saveDefinition, view]);

	return {
		view,
		profileId: activeProfileId,
		savePreferences,
		saveDefinition,
		isPersisted: Boolean(ownSaved),
	};
}
