import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Popover, Toolbar } from "@heroui/react";
import { Ellipsis } from "lucide-react";
import { applyInterfaceTypography } from "@/components/InterfaceTypography";

import { RESOURCE_VIEW_SLOTS } from "../../../src/workbench/resource-view-definition";
import { resolveToolbarLayout } from "../../../src/workbench/toolbar-layout";

import type { ReactNode } from "react";
import type { ResolvedNamedResourceView } from "../../../src/workbench/named-resource-views";
import type { ResourceViewSlot } from "../../../src/workbench/resource-view-definition";
import type { ToolbarControlLayout } from "../../../src/workbench/toolbar-layout";
import type { ToolbarWidgetRegistry } from "@/design-system/toolbar-template";

import "./resource-view-toolbar.css";

export interface ResourceToolbarExtra {
	readonly id: string;
	readonly slot: ResourceViewSlot;
	readonly label: string;
	readonly content: ReactNode;
	readonly overflowContent?: ReactNode;
	readonly layout: ToolbarControlLayout;
}

interface Control extends ResourceToolbarExtra {
	readonly align: "start" | "end";
	readonly groupLabel: string;
}
interface Widths { readonly full: number; readonly icon: number }
interface Measurements { readonly controls: readonly Control[]; readonly widths: ReadonlyMap<string, Widths> }
const EMPTY_EXTRAS: readonly ResourceToolbarExtra[] = [];

/** Semantic groups stay portable; measured widths and the overflow popover belong to this adapter. */
export function ResourceViewToolbar({ view, widgets, overflowWidgets, extras = EMPTY_EXTRAS }: {
	view: ResolvedNamedResourceView;
	widgets: ToolbarWidgetRegistry;
	overflowWidgets?: ToolbarWidgetRegistry;
	extras?: readonly ResourceToolbarExtra[];
}): ReactNode {
	const container = useRef<HTMLDivElement>(null);
	const probe = useRef<HTMLDivElement>(null);
	const [availableWidth, setAvailableWidth] = useState(0);
	const [measurements, setMeasurements] = useState<Measurements | null>(null);
	const [open, setOpen] = useState(false);
	const controls = useMemo(() => RESOURCE_VIEW_SLOTS.flatMap((slot): Control[] => {
		const group = view.definition.toolbar?.groups[slot];
		const base = { slot, align: group?.align ?? (slot.includes("actions") || slot.includes("state") ? "end" as const : "start" as const),
			groupLabel: group?.label ?? slot.split(".").at(-1)! };
		const registered = (view.definition.slots[slot] ?? []).flatMap((control): Control[] => {
			const feature = view.features.slots[slot]?.find((feature) => feature.id === control.id);
			const widget = feature?.implementation ? widgets[feature.implementation] : undefined;
			if (feature?.implementation && Object.hasOwn(widgets, feature.implementation) && (widget === null || widget === false)) return [];
			return [{ ...base, id: control.id, label: control.label,
				overflowContent: feature?.implementation ? overflowWidgets?.[feature.implementation] : undefined,
				layout: control.layout ?? { priority: 50, collapse: control.command ? "icon" : "none", overflow: !!control.command },
				content: widget ?? <span role="status" className="text-xs text-warning">{control.label}: {feature?.diagnostic ?? "No browser adapter"}</span>,
			}];
		});
		return [...registered, ...extras.filter((extra) => extra.slot === slot && extra.content != null && extra.content !== false)
			.map((extra) => ({ ...base, ...extra, id: `$extra:${extra.id}` }))];
	}), [view, widgets, overflowWidgets, extras]);
	const needsMeasurement = measurements?.controls !== controls;

	useLayoutEffect(() => {
		const element = container.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setAvailableWidth(element.clientWidth - 24));
		setAvailableWidth(element.clientWidth - 24);
		observer.observe(element);
		const fontsChanged = () => setMeasurements(null);
		document.fonts.addEventListener("loadingdone", fontsChanged);
		return () => { observer.disconnect(); document.fonts.removeEventListener("loadingdone", fontsChanged); };
	}, []);

	useLayoutEffect(() => {
		const element = probe.current;
		if (!needsMeasurement || !element) return;
		const widths = new Map<string, Widths>();
		const nodes = [...element.querySelectorAll<HTMLElement>("[data-measure-control]")];
		element.dataset.labels = "full";
		applyInterfaceTypography(element, true);
		for (const node of nodes) widths.set(node.dataset.measureControl!, { full: Math.ceil(node.getBoundingClientRect().width), icon: 0 });
		element.dataset.labels = "icons";
		for (const node of nodes) widths.set(node.dataset.measureControl!, { full: widths.get(node.dataset.measureControl!)!.full,
			icon: Math.ceil(node.getBoundingClientRect().width) });
		setMeasurements({ controls, widths });
	}, [controls, needsMeasurement]);

	const layout = resolveToolbarLayout(controls.map((control) => ({ ...control.layout, id: control.id, group: control.slot,
		fullWidth: measurements?.widths.get(control.id)?.full ?? 180,
		iconWidth: measurements?.widths.get(control.id)?.icon ?? 36,
	})), Math.max(0, availableWidth), view.definition.toolbar?.maxRows ?? 2, { overflowWidth: 36 });
	const byId = new Map(controls.map((control) => [control.id, control]));
	const overflowControls = controls.filter((control) => layout.overflowIds.includes(control.id));
	const renderControl = (control: Control, measuring = false, overflowing = false) => <div key={control.id}
		data-resource-control={measuring ? undefined : control.id}
		data-measure-control={measuring ? control.id : undefined}
		data-toolbar-collapse={control.layout.collapse}
		data-toolbar-kind={control.layout.kind ?? (control.layout.collapse === "icon" ? "action" : "value")}
		data-measured-width={measuring ? undefined : measurements?.widths.get(control.id)?.[!overflowing && layout.labels === "icons" && (control.layout.collapse === "icon" || control.layout.collapse === "value") ? "icon" : "full"]}
		className="resource-toolbar-control" title={control.label}
		onClickCapture={overflowing && (control.layout.kind ?? (control.layout.collapse === "icon" ? "action" : "value")) === "action" ? (event) => {
			const button = event.target instanceof Element ? event.target.closest("button") : null;
			if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") setOpen(false);
		} : undefined}>
		{overflowing ? control.overflowContent ?? control.content : control.content}
	</div>;
	const more = <Popover isOpen={open && overflowControls.length > 0} onOpenChange={setOpen}>
		<Button isIconOnly size="sm" variant="ghost" aria-label="More Inbox controls"><Ellipsis className="h-4 w-4" aria-hidden="true" /></Button>
		<Popover.Content placement="bottom end" className="resource-toolbar-overflow max-h-[70vh] w-80 max-w-[calc(100vw-24px)] overflow-auto">
			<Popover.Dialog aria-label="More Inbox controls">
				{RESOURCE_VIEW_SLOTS.map((slot) => {
					const group = overflowControls.filter((control) => control.slot === slot);
					return group.length ? <section key={slot} aria-label={group[0]!.groupLabel} className="border-b border-border p-2 last:border-b-0">
						<h2 className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">{group[0]!.groupLabel}</h2>
						<div className="flex flex-wrap items-center gap-2" data-resource-slot={slot}>{group.map((control) => renderControl(control, false, true))}</div>
					</section> : null;
				})}
			</Popover.Dialog>
		</Popover.Content>
	</Popover>;
	const renderGroups = (ids: readonly string[], align: "start" | "end") => {
		const assigned = ids.filter((id) => byId.get(id)?.align === align);
		return RESOURCE_VIEW_SLOTS.map((slot) => {
			const group = assigned.map((id) => byId.get(id)!).filter((control) => control.slot === slot);
			return group.length ? <div key={slot} data-resource-slot={slot} className="resource-toolbar-group" aria-label={group[0]!.groupLabel}>
				{group.map((control) => renderControl(control))}
			</div> : null;
		});
	};
	return <div ref={container} className="resource-toolbar relative shrink-0" data-labels={layout.labels}
		data-layout-fits={layout.fits} data-layout-rows={layout.rows.length} data-identity-hidden={layout.hiddenIds.length > 0}>
		{layout.rows.map((ids, index) => <Toolbar key={index} aria-label={index === 0 ? "Inbox controls" : "Inbox view controls"}
			data-toolbar-row={index === 0 ? "named-primary" : "named-secondary"}
			className="resource-toolbar-row !flex !w-full !items-center !justify-between rounded-none border-b border-border bg-surface-secondary/35">
			<div className="resource-toolbar-side" data-align="start">{renderGroups(ids, "start")}</div>
			<div className="resource-toolbar-side" data-align="end">{renderGroups(ids, "end")}{ids.includes("$overflow") ? more : null}</div>
		</Toolbar>)}
		{needsMeasurement && <div ref={probe} className="resource-toolbar-measure toolbar toolbar--horizontal" aria-hidden="true" inert data-labels="full">
			{controls.map((control) => renderControl(control, true))}
		</div>}
	</div>;
}
