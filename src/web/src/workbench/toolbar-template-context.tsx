import { createContext, use, useMemo, useRef, type ReactNode } from "react";

import { parseToolbarTemplate } from "@/design-system/toolbar-template";
import { isJsonObject } from "@/lib/api";
import { useWorkbenchProfile } from "./profile-context";
import {
	DEFAULT_TOOLBAR_TEMPLATES,
	TOOLBAR_SCREEN_IDS,
	TOOLBAR_WIDGET_IDS,
} from "./toolbar-defaults";

import type {
	ToolbarScreenId,
	ToolbarTemplateItem,
	WorkbenchToolbarTemplate,
} from "@/design-system/toolbar-template";
import type { JsonObject } from "@/lib/api";

const LEGACY_STORAGE_KEY = "coleo:toolbar-templates:v1";

type ToolbarTemplateMap = Record<ToolbarScreenId, WorkbenchToolbarTemplate>;
type ToolbarTemplateOverrides = Partial<ToolbarTemplateMap>;

interface ToolbarTemplateContextValue {
	profileId: string | null;
	templates: ToolbarTemplateMap;
	setTemplate: (
		screenId: ToolbarScreenId,
		template: WorkbenchToolbarTemplate,
	) => Promise<void>;
	resetTemplate: (screenId: ToolbarScreenId) => Promise<void>;
}

const ToolbarTemplateContext = createContext<ToolbarTemplateContextValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function templateItemToJson(item: ToolbarTemplateItem): JsonObject {
	const value: JsonObject = { id: item.id, kind: item.kind };
	if (item.hidden !== undefined) value.hidden = item.hidden;
	if (item.kind === "widget") {
		value.widget = item.widget;
		if (item.label !== undefined) value.label = item.label;
	}
	if (item.kind === "label") value.text = item.text;
	return value;
}

function templateToJson(template: WorkbenchToolbarTemplate): JsonObject {
	return {
		id: template.id,
		rows: template.rows.map((row) => ({
			id: row.id,
			label: row.label,
			size: row.size,
			items: row.items.map(templateItemToJson),
		})),
	};
}

function templatesMatch(
	left: WorkbenchToolbarTemplate,
	right: WorkbenchToolbarTemplate,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function parseOverrides(value: unknown): ToolbarTemplateOverrides {
	if (!isRecord(value)) return {};
	const overrides: ToolbarTemplateOverrides = {};
	for (const screenId of TOOLBAR_SCREEN_IDS) {
		const candidate = value[screenId];
		if (candidate === undefined) continue;
		try {
			overrides[screenId] = parseToolbarTemplate(
				candidate,
				screenId,
				TOOLBAR_WIDGET_IDS[screenId],
			);
		} catch {
			// Invalid screens fall back independently without discarding other overrides.
		}
	}
	return overrides;
}

function readLegacyOverrides(): ToolbarTemplateOverrides {
	if (typeof localStorage === "undefined") return {};
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null");
		if (!isRecord(stored) || stored.version !== 1) return {};
		const parsed = parseOverrides(stored.templates);
		const overrides: ToolbarTemplateOverrides = {};
		for (const screenId of TOOLBAR_SCREEN_IDS) {
			const template = parsed[screenId];
			if (template && !templatesMatch(template, DEFAULT_TOOLBAR_TEMPLATES[screenId])) {
				overrides[screenId] = template;
			}
		}
		return overrides;
	} catch {
		return {};
	}
}

function overridesToJson(overrides: ToolbarTemplateOverrides): JsonObject {
	const value: JsonObject = {};
	for (const screenId of TOOLBAR_SCREEN_IDS) {
		const template = overrides[screenId];
		if (template) value[screenId] = templateToJson(template);
	}
	return value;
}

export function ToolbarTemplateProvider({ children }: { children: ReactNode }) {
	const { profile, updateProfilePreferences } = useWorkbenchProfile();
	const initialProfileIdRef = useRef<string | null>(null);
	const legacyOverridesRef = useRef<ToolbarTemplateOverrides | null>(null);
	if (legacyOverridesRef.current === null) legacyOverridesRef.current = readLegacyOverrides();
	if (profile && initialProfileIdRef.current === null) initialProfileIdRef.current = profile.id;

	const hasProfileOverrides = profile
		? Object.prototype.hasOwnProperty.call(profile.preferences, "toolbarTemplates")
		: false;
	const profileOverrides = parseOverrides(profile?.preferences.toolbarTemplates);
	const shouldUseLegacy = Boolean(
		profile &&
		profile.id === initialProfileIdRef.current &&
		!hasProfileOverrides,
	);
	const templates = useMemo<ToolbarTemplateMap>(() => {
		const effectiveOverrides = shouldUseLegacy
			? { ...legacyOverridesRef.current, ...profileOverrides }
			: profileOverrides;
		return { ...DEFAULT_TOOLBAR_TEMPLATES, ...effectiveOverrides };
	}, [profileOverrides, shouldUseLegacy]);

	const persistTemplate = async (
		screenId: ToolbarScreenId,
		template: WorkbenchToolbarTemplate | null,
	) => {
		if (!profile) throw new Error("No active workbench profile is available");
		await updateProfilePreferences((current) => {
			const stored = current.toolbarTemplates;
			const toolbarTemplates: JsonObject = isJsonObject(stored)
				? { ...stored }
				: shouldUseLegacy
					? overridesToJson(legacyOverridesRef.current ?? {})
					: {};
			if (!template || templatesMatch(template, DEFAULT_TOOLBAR_TEMPLATES[screenId])) {
				delete toolbarTemplates[screenId];
			} else {
				toolbarTemplates[screenId] = templateToJson(template);
			}
			return { ...current, toolbarTemplates };
		});
		if (shouldUseLegacy) {
			try {
				localStorage.removeItem(LEGACY_STORAGE_KEY);
			} catch {
				// The profile is authoritative even if legacy browser storage cannot be removed.
			}
		}
	};

	return (
		<ToolbarTemplateContext
			value={{
				profileId: profile?.id ?? null,
				templates,
				setTemplate: persistTemplate,
				resetTemplate: (screenId) => persistTemplate(screenId, null),
			}}
		>
			{children}
		</ToolbarTemplateContext>
	);
}

export function useToolbarTemplates(): ToolbarTemplateContextValue {
	const context = use(ToolbarTemplateContext);
	if (!context) throw new Error("useToolbarTemplates must be used within ToolbarTemplateProvider");
	return context;
}

export function useToolbarTemplate(screenId: ToolbarScreenId): WorkbenchToolbarTemplate {
	return useToolbarTemplates().templates[screenId];
}
