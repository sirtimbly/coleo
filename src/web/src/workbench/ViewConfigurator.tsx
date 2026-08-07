/**
 * Advanced saved-view configuration.
 *
 * The dialog stays out of the primary workflow but exposes column visibility,
 * order, widths, filters, density, sort precedence, and sharing. Changes are
 * passed to the profile-backed view store by the containing projection.
 */

import { useMemo } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@heroui/react";

import { WorkbenchHeader } from "@/design-system/WorkbenchSurface";

import type {
	ColumnPreference,
	ProjectionSort,
	ViewPreferences,
} from "./types";

export interface ConfigurableColumn {
	id: string;
	header: string;
	defaultWidth?: number;
	hideable?: boolean;
	sortable?: boolean;
}

function normalizedColumns(
	columns: ConfigurableColumn[],
	preferences: ViewPreferences,
): ColumnPreference[] {
	const saved = new Map(preferences.columns?.map((column) => [column.id, column]));
	return columns
		.map((column, index) => ({
			id: column.id,
			visible: saved.get(column.id)?.visible ?? true,
			order: saved.get(column.id)?.order ?? index,
			width: saved.get(column.id)?.width ?? column.defaultWidth,
		}))
		.sort((left, right) => left.order - right.order);
}

export function ViewConfigurator({
	open,
	columns,
	preferences,
	shared,
	onChange,
	onSharedChange,
	onClose,
}: {
	open: boolean;
	columns: ConfigurableColumn[];
	preferences: ViewPreferences;
	shared?: boolean;
	onChange: (preferences: ViewPreferences) => void;
	onSharedChange?: (shared: boolean) => void;
	onClose: () => void;
}) {
	const configuredColumns = useMemo(
		() => normalizedColumns(columns, preferences),
		[columns, preferences],
	);

	if (!open) return null;

	const updateColumns = (next: ColumnPreference[]) => {
		onChange({
			...preferences,
			columns: next.map((column, order) => ({ ...column, order })),
		});
	};

	const moveColumn = (index: number, direction: -1 | 1) => {
		const target = index + direction;
		if (target < 0 || target >= configuredColumns.length) return;
		const next = [...configuredColumns];
		[next[index], next[target]] = [next[target], next[index]];
		updateColumns(next);
	};

	const sort = preferences.sort ?? [];
	const primarySort = sort[0];
	const filters = preferences.filters ?? [];

	return (
		<div className="absolute inset-0 z-[1200] flex items-start justify-end bg-background/55 backdrop-blur-[1px]">
			<section className="h-full w-full max-w-sm overflow-auto border-l border-border bg-surface shadow-lg">
				<WorkbenchHeader
					title="Configure view"
					description="Saved to your active workbench profile"
					actions={(
						<Button isIconOnly size="sm" variant="ghost" onPress={onClose} aria-label="Close configuration">
							<X className="h-4 w-4" />
						</Button>
					)}
				/>

				<div className="space-y-6 p-4">
					<div>
						<div className="mb-2 flex items-center justify-between">
							<h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
								Columns
							</h2>
							<Button
								size="sm"
								variant="ghost"
								onPress={() => onChange({ ...preferences, columns: undefined })}
							>
								<RotateCcw className="h-3.5 w-3.5" />
								Reset
							</Button>
						</div>
						<div className="divide-y divide-border border border-border">
							{configuredColumns.map((column, index) => {
								const definition = columns.find((item) => item.id === column.id);
								const canHide = definition?.hideable !== false;
								return (
									<div key={column.id} className="flex items-center gap-2 px-2 py-2">
										<Button
											isIconOnly
											size="sm"
											variant="ghost"
											isDisabled={!canHide}
											onPress={() => updateColumns(configuredColumns.map((item) =>
												item.id === column.id ? { ...item, visible: !item.visible } : item
											))}
											aria-label={`${column.visible ? "Hide" : "Show"} ${definition?.header ?? column.id}`}
										>
											{column.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
										</Button>
										<span className="min-w-0 flex-1 truncate text-sm">
											{definition?.header ?? column.id}
										</span>
										<Button
											isIconOnly
											size="sm"
											variant="ghost"
											isDisabled={index === 0}
											onPress={() => moveColumn(index, -1)}
											aria-label={`Move ${definition?.header ?? column.id} up`}
										>
											<ArrowUp className="h-3.5 w-3.5" />
										</Button>
										<Button
											isIconOnly
											size="sm"
											variant="ghost"
											isDisabled={index === configuredColumns.length - 1}
											onPress={() => moveColumn(index, 1)}
											aria-label={`Move ${definition?.header ?? column.id} down`}
										>
											<ArrowDown className="h-3.5 w-3.5" />
										</Button>
									</div>
								);
							})}
						</div>
					</div>

					<div>
						<h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
							Primary sort
						</h2>
						<div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2">
							<select
								value={primarySort?.field ?? ""}
								onChange={(event) => onChange({
									...preferences,
									sort: event.target.value
										? [{ field: event.target.value, direction: primarySort?.direction ?? "asc" }]
										: [],
								})}
								aria-label="Sort field"
								className="h-9 border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-accent"
							>
								<option value="">Natural order</option>
								{columns.filter((column) => column.sortable !== false).map((column) => (
									<option key={column.id} value={column.id}>{column.header}</option>
								))}
							</select>
							<select
								value={primarySort?.direction ?? "asc"}
								onChange={(event) => {
									if (!primarySort) return;
									const direction = event.target.value === "desc" ? "desc" : "asc";
									const next: ProjectionSort = { ...primarySort, direction };
									onChange({ ...preferences, sort: [next] });
								}}
								disabled={!primarySort}
								aria-label="Sort direction"
								className="h-9 border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-accent disabled:opacity-50"
							>
								<option value="asc">Ascending</option>
								<option value="desc">Descending</option>
							</select>
						</div>
					</div>

					<div>
						<div className="mb-2 flex items-center justify-between">
							<h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
								Saved filters
							</h2>
							<Button
								size="sm"
								variant="ghost"
								onPress={() => onChange({
									...preferences,
									filters: [
										...filters,
										{
											field: columns[0]?.id ?? "",
											operator: "contains",
											value: "",
										},
									],
								})}
							>
								<Plus className="h-3.5 w-3.5" />
								Add
							</Button>
						</div>
						<div className="space-y-2">
							{filters.length === 0 ? (
								<p className="border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
									No saved filters. Temporary spreadsheet filters remain available in each column menu.
								</p>
							) : filters.map((filter, index) => (
								<div key={`${filter.field}-${index}`} className="grid grid-cols-[1fr_7rem_1fr_2rem] gap-1">
									<select
										value={filter.field}
										onChange={(event) => onChange({
											...preferences,
											filters: filters.map((item, itemIndex) =>
												itemIndex === index ? { ...item, field: event.target.value } : item
											),
										})}
										aria-label={`Filter ${index + 1} field`}
										className="h-9 min-w-0 border border-border bg-surface px-2 text-xs"
									>
										{columns.map((column) => (
											<option key={column.id} value={column.id}>{column.header}</option>
										))}
									</select>
									<select
										value={filter.operator}
										onChange={(event) => onChange({
											...preferences,
											filters: filters.map((item, itemIndex) =>
												itemIndex === index
													? { ...item, operator: event.target.value as typeof item.operator }
													: item
											),
										})}
										aria-label={`Filter ${index + 1} operator`}
										className="h-9 border border-border bg-surface px-2 text-xs"
									>
										<option value="contains">Contains</option>
										<option value="equals">Equals</option>
										<option value="notEquals">Not equal</option>
										<option value="in">One of</option>
										<option value="notIn">Not one of</option>
										<option value="before">Before</option>
										<option value="after">After</option>
										<option value="exists">Exists</option>
									</select>
									<input
										value={typeof filter.value === "string" ? filter.value : String(filter.value ?? "")}
										onChange={(event) => onChange({
											...preferences,
											filters: filters.map((item, itemIndex) =>
												itemIndex === index ? { ...item, value: event.target.value } : item
											),
										})}
										disabled={filter.operator === "exists"}
										placeholder={filter.operator === "in" || filter.operator === "notIn" ? "a, b, c" : "Value"}
										aria-label={`Filter ${index + 1} value`}
										className="h-9 min-w-0 border border-border bg-surface px-2 text-xs disabled:opacity-40"
									/>
									<Button
										isIconOnly
										size="sm"
										variant="ghost"
										onPress={() => onChange({
											...preferences,
											filters: filters.filter((_item, itemIndex) => itemIndex !== index),
										})}
										aria-label={`Remove filter ${index + 1}`}
									>
										<Trash2 className="h-3.5 w-3.5" />
									</Button>
								</div>
							))}
						</div>
					</div>

					<div>
						<h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
							Density
						</h2>
						<select
							value={preferences.density ?? "compact"}
							onChange={(event) => onChange({
								...preferences,
								density: event.target.value === "comfortable" ? "comfortable" : "compact",
							})}
							aria-label="Row density"
							className="h-9 w-full border border-border bg-surface px-2 text-xs text-foreground outline-none focus:border-accent"
						>
							<option value="compact">Compact</option>
							<option value="comfortable">Comfortable</option>
						</select>
					</div>

					{onSharedChange ? (
						<label className="flex items-start gap-3 border border-border bg-surface-secondary/35 p-3 text-sm">
							<input
								type="checkbox"
								checked={shared ?? false}
								onChange={(event) => onSharedChange(event.target.checked)}
								className="mt-0.5 accent-[var(--accent)]"
							/>
							<span>
								<span className="block font-medium text-foreground">Share this saved view</span>
								<span className="mt-0.5 block text-xs text-muted-foreground">
									Other registered profiles can import or reuse this configuration.
								</span>
							</span>
						</label>
					) : null}
				</div>
			</section>
		</div>
	);
}
