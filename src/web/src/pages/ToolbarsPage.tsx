import {
	useEffect,
	useEffectEvent,
	useRef,
	useState,
	type ChangeEvent,
	type ReactNode,
} from "react";
import { Button, ButtonGroup, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import {
	AlignJustify,
	CircleHelp,
	Download,
	Eye,
	LayoutGrid,
	Plus,
	RefreshCw,
	RotateCcw,
	Save,
	Sparkles,
	Table2,
	Upload,
	WandSparkles,
} from "lucide-react";

import { ProjectionMenuTrigger } from "@/design-system/ProjectionControls";
import {
	ToolbarTemplateRows,
	parseToolbarTemplateJson,
	type ToolbarScreenId,
	type ToolbarWidgetRegistry,
	type WorkbenchToolbarTemplate,
} from "@/design-system/toolbar-template";
import {
	WorkbenchHeader,
	WorkbenchSurface,
} from "@/design-system/WorkbenchSurface";
import { usePageTitle } from "@/hooks/usePageTitle";
import {
	DEFAULT_TOOLBAR_TEMPLATES,
	TOOLBAR_SCREEN_IDS,
	TOOLBAR_SCREEN_LABELS,
	TOOLBAR_WIDGET_IDS,
} from "@/workbench/toolbar-defaults";
import { useToolbarTemplates } from "@/workbench/toolbar-template-context";

function formatWidgetLabel(widgetId: string): string {
	return widgetId
		.split(".")
		.at(-1)!
		.replaceAll("-", " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());
}

function previewWidget(widgetId: string): ReactNode {
	const label = formatWidgetLabel(widgetId);

	if (widgetId.endsWith(".identity")) {
		return (
			<div className="flex min-w-40 shrink-0 items-center gap-2">
				<span className="flex h-7 w-7 items-center justify-center border border-border bg-surface text-xs font-bold text-accent">
					C
				</span>
				<div className="min-w-0">
					<div className="truncate text-sm font-semibold">{label}</div>
					<div className="truncate text-[0.68rem] text-muted-foreground">Toolbar preview</div>
				</div>
			</div>
		);
	}

	if (widgetId.endsWith(".search")) {
		return (
			<label className="relative block min-w-44 max-w-64 flex-1">
				<span className="sr-only">Preview search</span>
				<input
					readOnly
					value="Search this view..."
					className="h-8 w-full border border-border bg-surface px-3 text-xs text-muted-foreground outline-none"
				/>
			</label>
		);
	}

	if (widgetId === "collection.view-mode" || widgetId === "arms.display") {
		return (
			<ButtonGroup size="sm" variant="ghost" aria-label="Preview display mode">
				<Button variant="secondary" className="h-7 min-w-0 px-2">
					<Table2 className="h-3.5 w-3.5" aria-hidden="true" />
					Grid
				</Button>
				<Button className="h-7 min-w-0 px-2">
					<LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
					Cards
				</Button>
			</ButtonGroup>
		);
	}

	if (widgetId === "collection.grid-density") {
		return (
			<ButtonGroup size="sm" variant="ghost" aria-label="Preview density">
				<Button isIconOnly variant="secondary" className="h-7 min-h-7 w-7 min-w-7" aria-label="Compact rows">
					<AlignJustify className="h-3.5 w-3.5" />
				</Button>
				<Button isIconOnly className="h-7 min-h-7 w-7 min-w-7" aria-label="Full rows">
					<AlignJustify className="h-3.5 w-3.5" />
				</Button>
			</ButtonGroup>
		);
	}

	if (widgetId === "collection.card-presentation") {
		return (
			<ButtonGroup size="sm" variant="ghost" aria-label="Preview card detail">
				<Button variant="secondary" className="h-7 min-w-0 px-2">Compact</Button>
				<Button className="h-7 min-w-0 px-2">Full</Button>
			</ButtonGroup>
		);
	}

	if (widgetId === "collection.card-columns") {
		return (
			<div className="flex items-center gap-1" role="group" aria-label="Preview card columns">
				{[1, 2, 3, 4].map((count) => (
					<Button
						key={count}
						isIconOnly
						size="sm"
						variant={count === 2 ? "secondary" : "ghost"}
						className="h-7 min-h-7 w-7 min-w-7 text-xs"
					>
						{count}
					</Button>
				))}
			</div>
		);
	}

	if (widgetId === "plan-documents.scope") {
		const toggleClass = "inline-flex h-7 min-h-7 items-center justify-center px-2 text-xs font-medium text-muted-foreground outline-none data-[selected=true]:bg-accent/20 data-[selected=true]:text-accent";
		return (
			<ToggleButtonGroup
				aria-label="Preview files shown"
				selectionMode="single"
				disallowEmptySelection
				defaultSelectedKeys={["all"]}
				size="sm"
				className="inline-flex items-center"
			>
				<ToggleButton id="plan" variant="ghost" className={toggleClass}>Plan</ToggleButton>
				<ToggleButton id="coleo" variant="ghost" className={toggleClass}>Coleo dir</ToggleButton>
				<ToggleButton id="all" variant="ghost" className={toggleClass}>All files</ToggleButton>
			</ToggleButtonGroup>
		);
	}

	if (widgetId === "plan-documents.file-count") {
		return <span className="inline-flex shrink-0 self-center text-xs tabular-nums text-muted-foreground">48 files shown</span>;
	}

	if (widgetId === "plan-documents.document-status") {
		return <span className="inline-flex shrink-0 self-center bg-success/15 px-2 py-0.5 text-[11px] text-success">Saved</span>;
	}

	if (widgetId === "plan-documents.preview") {
		return <Button size="sm" variant="ghost" className="h-7 min-h-7 px-2"><Eye className="h-3.5 w-3.5" />Preview</Button>;
	}

	if (widgetId === "plan-documents.help") {
		return <Button isIconOnly size="sm" variant="ghost" aria-label="Preview help"><CircleHelp className="h-3.5 w-3.5" /></Button>;
	}

	if (widgetId === "plan-documents.save") {
		return <Button size="sm" variant="outline"><Save className="h-3.5 w-3.5" />Save</Button>;
	}

	if (widgetId === "plan-documents.prepare-tasks") {
		return <Button size="sm" variant="primary"><Sparkles className="h-3.5 w-3.5" />Prepare tasks</Button>;
	}

	if (widgetId === "plan-documents.regenerate-tasks") {
		return <Button size="sm" variant="outline" className="border-warning/50 text-warning"><RefreshCw className="h-3.5 w-3.5" />Regenerate All Tasks</Button>;
	}

	if (widgetId === "collection.configure" || widgetId.endsWith(".facet") || widgetId.endsWith(".scope")) {
		return <ProjectionMenuTrigger summary={label} className="h-7 min-h-7" />;
	}

	if (widgetId.endsWith("result-count") || widgetId.endsWith("status-summary")) {
		return <span className="inline-flex shrink-0 self-center items-center text-xs tabular-nums text-muted-foreground">24 of 48</span>;
	}

	if (widgetId.endsWith(".refresh")) {
		return (
			<Button isIconOnly size="sm" variant="ghost" aria-label={label}>
				<RefreshCw className="h-3.5 w-3.5" />
			</Button>
		);
	}

	if (widgetId.endsWith(".create") || widgetId.endsWith(".spawn")) {
		return (
			<Button size="sm" variant="primary">
				<Plus className="h-3.5 w-3.5" />
				{label}
			</Button>
		);
	}

	return <Button size="sm" variant="ghost" className="h-7 min-w-0 px-2">{label}</Button>;
}

function buildPreviewWidgets(screenId: ToolbarScreenId): ToolbarWidgetRegistry {
	return TOOLBAR_WIDGET_IDS[screenId].reduce<Record<string, ReactNode>>(
		(widgets, widgetId) => ({ ...widgets, [widgetId]: previewWidget(widgetId) }),
		{},
	);
}

function serialize(template: WorkbenchToolbarTemplate): string {
	return JSON.stringify(template, null, 2);
}

export function ToolbarsPage() {
	usePageTitle("Coleo Observatory - Toolbars");
	const { profileId, templates, setTemplate, resetTemplate } = useToolbarTemplates();
	const [screenId, setScreenId] = useState<ToolbarScreenId>("inbox");
	const [draft, setDraft] = useState(() => serialize(templates.inbox));
	const [preview, setPreview] = useState<WorkbenchToolbarTemplate>(templates.inbox);
	const [error, setError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [applied, setApplied] = useState(false);
	const [saving, setSaving] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const widgetIds = TOOLBAR_WIDGET_IDS[screenId];
	const previewWidgets = buildPreviewWidgets(screenId);
	const savedSource = serialize(templates[screenId]);
	const dirty = draft !== savedSource;
	const syncProfileTemplate = useEffectEvent(() => {
		const template = templates[screenId];
		setDraft(serialize(template));
		setPreview(template);
		setError(null);
		setSaveError(null);
		setApplied(false);
	});

	useEffect(() => {
		syncProfileTemplate();
	}, [profileId]);

	const selectScreen = (event: ChangeEvent<HTMLSelectElement>) => {
		const nextScreen = TOOLBAR_SCREEN_IDS.find((candidate) => candidate === event.target.value);
		if (!nextScreen) return;
		const nextTemplate = templates[nextScreen];
		setScreenId(nextScreen);
		setDraft(serialize(nextTemplate));
		setPreview(nextTemplate);
		setError(null);
		setSaveError(null);
		setApplied(false);
	};

	const updateDraft = (source: string) => {
		setDraft(source);
		setSaveError(null);
		setApplied(false);
		try {
			setPreview(parseToolbarTemplateJson(source, screenId, widgetIds));
			setError(null);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : "Invalid toolbar configuration");
		}
	};

	const formatDraft = () => {
		try {
			const template = parseToolbarTemplateJson(draft, screenId, widgetIds);
			setDraft(serialize(template));
			setPreview(template);
			setError(null);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : "Invalid toolbar configuration");
		}
	};

	const applyDraft = async () => {
		setSaving(true);
		setSaveError(null);
		try {
			const template = parseToolbarTemplateJson(draft, screenId, widgetIds);
			await setTemplate(screenId, template);
			setDraft(serialize(template));
			setPreview(template);
			setError(null);
			setApplied(true);
		} catch (nextError) {
			setSaveError(nextError instanceof Error ? nextError.message : "Could not save toolbar configuration");
		} finally {
			setSaving(false);
		}
	};

	const resetDraft = async () => {
		const template = DEFAULT_TOOLBAR_TEMPLATES[screenId];
		setSaving(true);
		setSaveError(null);
		try {
			await resetTemplate(screenId);
			setDraft(serialize(template));
			setPreview(template);
			setError(null);
			setApplied(true);
		} catch (nextError) {
			setSaveError(nextError instanceof Error ? nextError.message : "Could not reset toolbar configuration");
		} finally {
			setSaving(false);
		}
	};

	const downloadDraft = () => {
		try {
			const template = parseToolbarTemplateJson(draft, screenId, widgetIds);
			const blob = new Blob([serialize(template)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `coleo-toolbar-${screenId}.json`;
			anchor.click();
			URL.revokeObjectURL(url);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : "Invalid toolbar configuration");
		}
	};

	const uploadDraft = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) return;
		try {
			updateDraft(await file.text());
		} finally {
			event.target.value = "";
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<WorkbenchHeader
				title="Toolbar Playground"
				description="Edit, preview, and apply the real two-row toolbar layouts."
				icon={<WandSparkles className="h-4 w-4" />}
				actions={(
					<label className="flex items-center gap-2 text-xs text-muted-foreground">
						Screen
						<select
							value={screenId}
							onChange={selectScreen}
							className="h-8 border border-border bg-surface px-2 text-xs font-medium text-foreground outline-none focus:border-accent"
						>
							{TOOLBAR_SCREEN_IDS.map((id) => (
								<option key={id} value={id}>{TOOLBAR_SCREEN_LABELS[id]}</option>
							))}
						</select>
					</label>
				)}
			/>

			<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto p-3">
				<WorkbenchSurface className="min-w-0 shrink-0 overflow-hidden">
					<div className="border-b border-border px-3 py-2">
						<h2 className="text-sm font-semibold">Live preview</h2>
						<p className="text-xs text-muted-foreground">
							Resize the window to test the real toolbar wrapping and overflow behavior.
						</p>
					</div>
					<div className="bg-background py-4">
						<ToolbarTemplateRows template={preview} widgets={previewWidgets} />
					</div>
				</WorkbenchSurface>

				<div className="grid min-w-0 gap-3 xl:grid-cols-2">
					<WorkbenchSurface className="flex min-h-[32rem] min-w-0 flex-col">
						<div className="flex min-h-11 items-center gap-2 border-b border-border px-3 py-2">
							<div className="min-w-0 flex-1">
								<h2 className="text-sm font-semibold">{TOOLBAR_SCREEN_LABELS[screenId]} configuration</h2>
								<p className="text-xs text-muted-foreground">
									{error ? "Preview shows the last valid configuration." : dirty ? "Valid draft, not applied." : "Applied configuration."}
								</p>
							</div>
							<Button
								isIconOnly
								size="sm"
								variant="ghost"
								onPress={downloadDraft}
								isDisabled={error !== null}
								aria-label="Download toolbar configuration"
							>
								<Download className="h-3.5 w-3.5" />
							</Button>
							<Button
								isIconOnly
								size="sm"
								variant="ghost"
								onPress={() => fileInputRef.current?.click()}
								aria-label="Upload toolbar configuration"
							>
								<Upload className="h-3.5 w-3.5" />
							</Button>
							<input
								ref={fileInputRef}
								type="file"
								accept="application/json,.json"
								onChange={(event) => void uploadDraft(event)}
								className="hidden"
							/>
							<Button size="sm" variant="ghost" onPress={formatDraft} isDisabled={saving}>Format</Button>
							<Button size="sm" variant="ghost" onPress={() => void resetDraft()} isDisabled={saving}>
								<RotateCcw className="h-3.5 w-3.5" />
								Reset
							</Button>
							<Button
								size="sm"
								variant="primary"
								onPress={() => void applyDraft()}
								isDisabled={error !== null || saving || !profileId}
								isPending={saving}
							>
								Apply
							</Button>
						</div>
						<textarea
							value={draft}
							onChange={(event) => updateDraft(event.target.value)}
							spellCheck={false}
							aria-label={`${TOOLBAR_SCREEN_LABELS[screenId]} toolbar JSON`}
							className="min-h-[28rem] min-w-0 w-full flex-1 resize-none bg-surface p-4 font-mono text-xs leading-5 text-foreground outline-none focus:ring-2 focus:ring-inset focus:ring-accent/30"
						/>
						<div className="flex min-h-9 items-center border-t border-border px-3 py-2 text-xs">
							{error || saveError ? <span role="alert" className="text-danger">{error ?? saveError}</span> : null}
							{!error && !saveError && applied ? <span className="text-success">Applied to live pages and saved with the active profile.</span> : null}
							{!error && !saveError && !applied ? <span className="text-muted-foreground">Changes preview as soon as the JSON is valid.</span> : null}
						</div>
					</WorkbenchSurface>

					<WorkbenchSurface className="min-h-[32rem] min-w-0 overflow-auto p-4">
						<h2 className="text-sm font-semibold">Available widgets</h2>
						<p className="mt-1 text-xs leading-5 text-muted-foreground">
							Use these IDs in widget items. Labels, dividers, spacers, row sizes, order, and hidden flags are controlled directly by the JSON.
						</p>
						<div className="mt-3 flex flex-wrap gap-2">
							{widgetIds.map((widgetId) => (
								<code key={widgetId} className="border border-border bg-surface-secondary px-2 py-1 text-[0.7rem] text-foreground">
									{widgetId}
								</code>
							))}
						</div>
					</WorkbenchSurface>
				</div>
			</div>
		</div>
	);
}
