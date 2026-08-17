/**
 * Bugs Page
 *
 * Displays bug reports through shared data-grid and Adaptive Card projections,
 * with richer bug details in a dedicated workspace panel.
 */
import React, { useMemo, useState, useCallback, useDeferredValue } from 'react';
import {
	Activity,
	AlertTriangle,
	Bug as BugIcon,
	CheckCircle2,
	Clock,
	ExternalLink,
	Pencil,
	Tag,
	X,
} from 'lucide-react';
import { Button } from '@heroui/react';
import { AdaptiveCardView, DeferredAdaptiveCardView } from '@/adaptive-cards/AdaptiveCardView';
import { presentBugCard } from '@/adaptive-cards/bug-presenter';
import {
	BRAIN_CARD_CREATOR,
	createArmCardCreator,
	USER_CARD_CREATOR,
} from '@/adaptive-cards/card-creators';
import { createPersistedCardRoute } from '@/adaptive-cards/persisted-card-route';
import {
	presentResourceDetail,
	presentResourceEditor,
} from '@/adaptive-cards/presenters';
import { type Bug, type UiMetadata, cn, api } from '@/lib';
import { BugModal, StatusBurndownChart } from '@/components';
import type { BugUpdate } from '@/workbench/resource-updates';
import type { ResourceSheetRowMove } from '@/workbench/ResourceSheet';
import { useBugs } from '@/hooks/useBugs';
import { useQueryClient } from '@tanstack/react-query';
import { bugsKeys } from '@/lib/queryKeys';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import {
	WorkbenchHeader,
	WorkbenchSurface,
	WorkbenchToolbar,
} from '@/design-system/WorkbenchSurface';
import { CollectionRow } from '@/design-system/CollectionRow';
import {
	SheetInsightPanel,
	SheetWorkspaceToolbar,
	type SheetInsight,
} from '@/design-system/SheetWorkspaceToolbar';
import { normalizeRowColor, RowFormattingToolbar } from '@/design-system/RowFormattingToolbar';
import { AdaptiveCardCollection } from '@/workbench/AdaptiveCardCollection';
import { useCollectionDisplayPreferences } from '@/workbench/collection-display';
import { projectResourceCollection } from '@/workbench/resource-sheet-model';
import { useViewPreferences } from '@/workbench/use-view-preferences';
import { ViewConfigurator, type ConfigurableColumn } from '@/workbench/ViewConfigurator';
import {
	useIsWorkspacePanel,
	useWorkspaceCloseRoute,
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from '@/workspace/route-context';

type BugUiMeta = UiMetadata;

const BUG_VIEW_COLUMNS: ConfigurableColumn[] = [
	{ id: 'title', header: 'Subject', defaultWidth: 360, hideable: false },
	{ id: 'status', header: 'Status', defaultWidth: 128 },
	{ id: 'priority', header: 'Priority', defaultWidth: 104 },
	{ id: 'source', header: 'Source', defaultWidth: 136 },
	{ id: 'tags', header: 'Tags', defaultWidth: 180 },
	{ id: 'assignee', header: 'Arm', defaultWidth: 140 },
	{ id: 'createdAt', header: 'Created', defaultWidth: 170 },
	{ id: 'updatedAt', header: 'Updated', defaultWidth: 170 },
];

const BUG_COLLECTION_COLUMNS = [
	{ id: 'title', read: (bug: Bug) => bug.title },
	{ id: 'status', read: (bug: Bug) => bug.status },
	{ id: 'priority', read: (bug: Bug) => bug.priority },
	{ id: 'source', read: (bug: Bug) => bug.source },
	{ id: 'tags', read: (bug: Bug) => bug.metadata?.ui?.tags ?? [] },
	{ id: 'assignee', read: (bug: Bug) => bug.assigneeArmName ?? bug.assigneeArmId ?? '' },
	{ id: 'createdAt', read: (bug: Bug) => bug.createdAt },
	{ id: 'updatedAt', read: (bug: Bug) => bug.updatedAt },
];

const BugSheet = React.lazy(() =>
	import('@/workbench/BugSheet').then((module) => ({ default: module.BugSheet }))
);

function bugCardCreator(bug: Bug) {
	if (bug.source === 'human_reported') return USER_CARD_CREATOR;
	if (bug.source === 'arm_reported') {
		return createArmCardCreator(bug.sourceArmId ?? 'unknown-arm');
	}
	return BRAIN_CARD_CREATOR;
}

// Status configuration
const STATUS_CONFIG: Record<Bug['status'], { color: string; bgColor: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
	open: { color: 'text-red-500', bgColor: 'bg-red-500/10', icon: AlertTriangle, label: 'Open' },
	investigating: { color: 'text-yellow-500', bgColor: 'bg-yellow-500/10', icon: AlertTriangle, label: 'Investigating' },
	fixing: { color: 'text-blue-500', bgColor: 'bg-blue-500/10', icon: AlertTriangle, label: 'Fixing' },
	verifying: { color: 'text-purple-500', bgColor: 'bg-purple-500/10', icon: AlertTriangle, label: 'Verifying' },
	resolved: { color: 'text-green-500', bgColor: 'bg-green-500/10', icon: AlertTriangle, label: 'Resolved' },
	closed: { color: 'text-gray-500', bgColor: 'bg-gray-500/10', icon: AlertTriangle, label: 'Closed' },
};

// Priority configuration
const PRIORITY_CONFIG: Record<Bug['priority'], { color: string; bgColor: string; label: string }> = {
	critical: { color: 'text-red-500', bgColor: 'bg-red-500/20', label: 'Critical' },
	high: { color: 'text-orange-500', bgColor: 'bg-orange-500/20', label: 'High' },
	medium: { color: 'text-yellow-500', bgColor: 'bg-yellow-500/20', label: 'Medium' },
	low: { color: 'text-gray-500', bgColor: 'bg-gray-500/20', label: 'Low' },
};

function formatAbsoluteDateTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	});
}

function formatRelativeAge(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	const diffSeconds = Math.floor(diffMs / 1000);
	if (diffSeconds < 60) return 'just now';
	const diffMinutes = Math.floor(diffSeconds / 60);
	if (diffMinutes < 60) return `${diffMinutes}m ago`;
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 30) return `${diffDays}d ago`;
	const diffMonths = Math.floor(diffDays / 30);
	if (diffMonths < 12) return `${diffMonths}mo ago`;
	const diffYears = Math.floor(diffMonths / 12);
	return `${diffYears}y ago`;
}

function BugCreatedAt({ createdAt }: { createdAt: string }) {
	return (
		<span
			className="inline-flex items-center gap-1 text-xs text-foreground-500"
			title={formatAbsoluteDateTime(createdAt)}
		>
			<Clock className="h-3 w-3" aria-hidden="true" />
			Created {formatRelativeAge(createdAt)}
		</span>
	);
}

/**
 * Description field that shows an explicit empty state (instead of silently
 * rendering nothing) and lets you add/edit the description inline.
 */
function BugDescriptionField({
	bugId,
	description,
	onSave,
}: {
	bugId: string;
	description: string;
	onSave: (bugId: string, description: string) => void;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState(description);

	React.useEffect(() => {
		if (!isEditing) setDraft(description);
	}, [description, isEditing]);

	const handleSave = () => {
		const trimmed = draft.trim();
		setIsEditing(false);
		if (trimmed !== description) {
			onSave(bugId, trimmed);
		}
	};

	const handleCancel = () => {
		setDraft(description);
		setIsEditing(false);
	};

	if (isEditing) {
		return (
			<div className="space-y-2">
				<textarea
					autoFocus
					name="bug-description"
					aria-label="Bug description"
					autoComplete="off"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault();
							handleCancel();
						} else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							handleSave();
						}
					}}
					placeholder="Add a description for this bug…"
					rows={4}
					className="w-full resize-none rounded-md border border-border/70 bg-content2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
				/>
				<div className="flex items-center gap-2">
					<Button size="sm" variant="primary" onPress={handleSave}>
						Save
					</Button>
					<Button size="sm" variant="ghost" onPress={handleCancel}>
						Cancel
					</Button>
					<span className="text-xs text-foreground-500">⌘⏎ to save · Esc to cancel</span>
				</div>
			</div>
		);
	}

	if (!description.trim()) {
		return (
			<button
				type="button"
				onClick={() => setIsEditing(true)}
				className="w-full rounded-md border border-dashed border-border/70 px-3 py-3 text-left text-sm text-foreground-500 transition-colors hover:border-accent hover:text-foreground"
			>
				No description yet — click to add one
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setIsEditing(true)}
			className="w-full rounded-md px-3 py-2 -mx-3 text-left text-sm transition-colors hover:bg-content2"
			title="Click to edit"
		>
			<p className="whitespace-pre-wrap">{description}</p>
		</button>
	);
}

function BugDetailProjection({
	bug,
	onClose,
	onUpdate,
	onOpenCardEditor,
}: {
	bug: Bug;
	onClose?: () => void;
	onUpdate: (bugId: string, updates: BugUpdate) => void;
	onOpenCardEditor: () => void;
}) {
	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<WorkbenchHeader
				title={bug.title}
				description={`Bug ${bug.id}`}
				icon={<BugIcon className="h-4 w-4" aria-hidden="true" />}
				actions={(
					<>
						<Button size="sm" variant="ghost" onPress={onOpenCardEditor}>
							Edit as card
						</Button>
						{onClose ? (
							<Button isIconOnly size="sm" variant="ghost" onPress={onClose} aria-label="Close bug details">
								<X className="h-4 w-4" aria-hidden="true" />
							</Button>
						) : null}
					</>
				)}
			/>
			<WorkbenchToolbar>
				<span
					className={cn(
						'px-2 py-1 text-xs',
						PRIORITY_CONFIG[bug.priority].bgColor,
						PRIORITY_CONFIG[bug.priority].color,
					)}
				>
					{PRIORITY_CONFIG[bug.priority].label}
				</span>
				<BugCreatedAt createdAt={bug.createdAt} />
			</WorkbenchToolbar>
			<div className="min-h-0 flex-1 overflow-auto p-5">
				<div className="mx-auto grid max-w-4xl gap-4">
					<AdaptiveCardView
						envelope={presentResourceDetail({
							id: bug.id,
							kind: "bug",
							title: bug.title,
							description: bug.description,
							creator: bugCardCreator(bug),
							facts: [
								{ label: "Status", value: STATUS_CONFIG[bug.status].label },
								{ label: "Priority", value: PRIORITY_CONFIG[bug.priority].label },
								{ label: "Assigned", value: bug.assigneeArmName ?? "Unassigned" },
							],
						})}
					/>
				<WorkbenchSurface>
					<section className="p-4">
						<h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
							Description
						</h2>
						<BugDescriptionField
							bugId={bug.id}
							description={bug.description}
							onSave={(bugId, description) => onUpdate(bugId, { description })}
						/>
					</section>
					<CollectionRow title="Status" trailing={<span className={STATUS_CONFIG[bug.status].color}>{STATUS_CONFIG[bug.status].label}</span>} />
					<CollectionRow title="Source" trailing={<span className="capitalize">{bug.source.replace('_', ' ')}</span>} />
					<CollectionRow title="Assigned Arm" trailing={<span>{bug.assigneeArmName ?? 'Unassigned'}</span>} />
				</WorkbenchSurface>
				</div>
			</div>
		</div>
	);
}

function newestFirst(left: Bug, right: Bug): number {
	return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}

function BugActivityColumn({
	title,
	icon,
	bugs,
	empty,
	onOpenBug,
}: {
	title: string;
	icon: React.ReactNode;
	bugs: Bug[];
	empty: string;
	onOpenBug: (bug: Bug) => void;
}) {
	return (
		<div className="min-w-0 rounded-lg border border-border bg-background/70 p-3">
			<div className="mb-2 flex items-center gap-2">
				{icon}
				<span className="text-sm font-medium">{title}</span>
			</div>
			{bugs.length > 0 ? (
				<div className="space-y-1">
					{bugs.map((bug) => (
						<button
							key={bug.id}
							type="button"
							onClick={() => onOpenBug(bug)}
							className="flex w-full touch-manipulation items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span
								className={cn(
									"h-1.5 w-1.5 shrink-0 rounded-full bg-current",
									STATUS_CONFIG[bug.status].color,
								)}
								aria-hidden="true"
							/>
							<span className="min-w-0 flex-1 truncate text-sm">{bug.title}</span>
							<time
								dateTime={bug.updatedAt}
								className="shrink-0 text-xs tabular-nums text-muted-foreground"
								title={formatAbsoluteDateTime(bug.updatedAt)}
							>
								{formatRelativeAge(bug.updatedAt)}
							</time>
						</button>
					))}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">{empty}</p>
			)}
		</div>
	);
}

function BugActivity({
	bugs,
	onOpenBug,
}: {
	bugs: Bug[];
	onOpenBug: (bug: Bug) => void;
}) {
	const groups = useMemo(() => {
		const sorted = [...bugs].sort(newestFirst);
		return {
			active: sorted.filter((bug) => (
				bug.status === "investigating" ||
				bug.status === "fixing" ||
				bug.status === "verifying"
			)).slice(0, 5),
			reported: sorted.filter((bug) => bug.status === "open").slice(0, 5),
			resolved: sorted.filter((bug) => (
				bug.status === "resolved" || bug.status === "closed"
			)).slice(0, 5),
		};
	}, [bugs]);

	return (
		<div className="grid gap-3 bg-surface-secondary/40 p-3 lg:grid-cols-3">
			<BugActivityColumn
				title="Active Work"
				icon={<Activity className="h-4 w-4 text-accent" aria-hidden="true" />}
				bugs={groups.active}
				empty="No bugs are actively being worked."
				onOpenBug={onOpenBug}
			/>
			<BugActivityColumn
				title="Recently Reported"
				icon={<BugIcon className="h-4 w-4 text-danger" aria-hidden="true" />}
				bugs={groups.reported}
				empty="No open bugs in the loaded activity."
				onOpenBug={onOpenBug}
			/>
			<BugActivityColumn
				title="Recently Resolved"
				icon={<CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />}
				bugs={groups.resolved}
				empty="No recently resolved bugs."
				onOpenBug={onOpenBug}
			/>
		</div>
	);
}

function BugInsightPanel({
	activeInsight,
	bugs,
	burndownRefresh,
	onOpenBug,
}: {
	activeInsight: SheetInsight;
	bugs: Bug[];
	burndownRefresh: number;
	onOpenBug: (bug: Bug) => void;
}) {
	if (activeInsight === null) return null;

	return (
		<SheetInsightPanel
			resourceKey="bug"
			resourceName="Bug"
			activeInsight={activeInsight}
		>
			{activeInsight === "burndown" ? (
				<StatusBurndownChart
					entity="bug"
					refreshKey={burndownRefresh}
					embedded
					className="rounded-none border-0"
				/>
			) : (
				<BugActivity bugs={bugs} onOpenBug={onOpenBug} />
			)}
		</SheetInsightPanel>
	);
}

export function BugsPage() {
	const queryClient = useQueryClient();
	const isWorkspacePanel = useIsWorkspacePanel();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const closeWorkspaceRoute = useWorkspaceCloseRoute('/bugs');
	const [searchParams] = useWorkspaceSearchParams();
	const isNewBugPage = searchParams.get('new') === '1';
	usePageTitle(isNewBugPage ? 'Coleo Observatory - New Bug' : 'Coleo Observatory - Bugs');
	const [tagFilter, setTagFilter] = useState<string[]>([]);
	const [searchText, setSearchText] = useState('');
	const [selectedBug, setSelectedBug] = useState<Bug | null>(null);
	const [activeInsight, setActiveInsight] = useState<SheetInsight>(null);
	const [burndownRefresh, setBurndownRefresh] = useState(0);
	const [cardEditBugId, setCardEditBugId] = useState<string | null>(null);
	const [configuringView, setConfiguringView] = useState(false);
	const [formattingBug, setFormattingBug] = useState<Bug>();
	const { display, updateDisplay } = useCollectionDisplayPreferences({
		viewId: 'bugs-display',
		name: 'Bugs',
		resourceKind: 'bug',
	});
	const bugView = useViewPreferences('bugs-sheet', {
		id: 'bugs-sheet',
		name: 'Bugs',
		kind: 'sheet',
		resourceKind: 'bug',
		description: 'Bug collection filters, sorting, and grid columns',
		query: { resourceKinds: ['bug'] },
		preferences: { density: 'compact', sort: [] },
		shared: false,
	});
	const bugViewPreferences = useMemo(
		() => bugView.preferences.density === display.density
			? bugView.preferences
			: { ...bugView.preferences, density: display.density },
		[bugView.preferences, display.density],
	);
	const deferredSearchText = useDeferredValue(searchText);

	// Use React Query hook for bugs
	const {
		bugs,
		isLoading,
		isError,
		error,
		refetch,
		updateBug,
		createBugAsync,
		deleteBug,
		reorderBugAsync,
	} = useBugs();

	const getBugUiMeta = useCallback((bug: Bug): BugUiMeta => {
		const ui = bug.metadata?.ui;
		return {
			tags: ui?.tags ?? [],
			color: ui?.color ?? 'slate',
			bold: ui?.bold ?? false,
		};
	}, []);

	const availableTags = useMemo(() => {
		const tagSet = new Set<string>();
		bugs.forEach((bug) => {
			getBugUiMeta(bug).tags?.forEach((tag) => {
				tagSet.add(tag);
			});
		});
		return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
	}, [bugs, getBugUiMeta]);

	const filteredBugs = useMemo(() => {
		let result = bugs;

		if (deferredSearchText.trim()) {
			const search = deferredSearchText.toLowerCase();
			result = result.filter(
				(bug) =>
					bug.title.toLowerCase().includes(search) ||
					bug.description.toLowerCase().includes(search)
			);
		}

		if (tagFilter.length > 0) {
			result = result.filter((bug) => {
				const tags = getBugUiMeta(bug).tags ?? [];
				return tagFilter.some((tag) => tags.includes(tag));
			});
		}

		return projectResourceCollection(result, BUG_COLLECTION_COLUMNS, bugViewPreferences);
	}, [bugs, tagFilter, deferredSearchText, getBugUiMeta, bugViewPreferences]);

	const handleUpdateBug = useCallback(
		async (bugId: string, updates: BugUpdate) => {
			// Optimistic update is handled by the mutation
			updateBug({ id: bugId, updates });
		},
		[updateBug]
	);

	const handleDeleteBug = useCallback(
		(bug: Bug) => {
			if (confirm('Are you sure you want to delete this bug?')) {
				deleteBug(bug.id);
			}
		},
		[deleteBug]
	);

	const handleCreateBugAt = useCallback(
		async (index: number, title: string) => {
			try {
				const created = await createBugAsync({
					title,
					description: title,
					source: 'human_reported',
					priority: 'medium',
				});
				await reorderBugAsync({
					bugId: created.id,
					fromSortOrder: created.sortOrder ?? bugs.length,
					toSortOrder: index,
				});
			} catch {
				// Error is handled by the mutation
			}
		},
		[bugs.length, createBugAsync, reorderBugAsync]
	);

	const handleRowsMove = useCallback(
		async (moves: ResourceSheetRowMove<Bug>[]) => {
			let workingOrder = [...bugs];
			for (const move of moves) {
				const fromIndex = workingOrder.findIndex((bug) => bug.id === move.row.id);
				const movedBug = fromIndex >= 0 ? workingOrder[fromIndex] : move.row;
				const remaining = workingOrder.filter((bug) => bug.id !== move.row.id);
				const nextIndex = move.nextRow
					? remaining.findIndex((bug) => bug.id === move.nextRow?.id)
					: -1;
				const previousIndex = move.previousRow
					? remaining.findIndex((bug) => bug.id === move.previousRow?.id)
					: -1;
				const targetIndex = nextIndex >= 0
					? nextIndex
					: previousIndex >= 0
						? previousIndex + 1
						: Math.max(0, Math.min(move.toIndex, remaining.length));
				await reorderBugAsync({
					bugId: move.row.id,
					fromSortOrder: move.row.sortOrder ?? Math.max(0, fromIndex),
					toSortOrder: targetIndex,
				});
				remaining.splice(targetIndex, 0, movedBug);
				workingOrder = remaining;
			}
		},
		[bugs, reorderBugAsync],
	);

	const handleOpenDetails = useCallback((bug: Bug) => {
		const nextSearchParams = new URLSearchParams(searchParams);
		nextSearchParams.set('bug', bug.id);
		openWorkspaceRoute(
			{ pathname: '/bugs', search: `?${nextSearchParams.toString()}`, title: `Bug: ${bug.title}` },
			'split',
		);
	}, [openWorkspaceRoute, searchParams]);
	const handleBugCardAction = useCallback(async (request: import('../../../types/adaptive-cards').CardActionRequest) => {
		await api.executeWorkbenchCardAction(request);
		setCardEditBugId(null);
		await queryClient.invalidateQueries({ queryKey: bugsKeys.all(), refetchType: 'active' });
	}, [queryClient]);
	const bugCardCollection = (
		<AdaptiveCardCollection
			items={filteredBugs}
			columns={display.cardColumns}
			presentation={display.cardPresentation}
			getKey={(bug) => bug.id}
			renderCard={(bug, presentation) => (
				<DeferredAdaptiveCardView
					envelope={presentBugCard(bug, cardEditBugId === bug.id, bugCardCreator(bug))}
					onAction={handleBugCardAction}
					presentationMode={presentation}
					headerActions={(
						<Button
							isIconOnly
							size="sm"
							variant={cardEditBugId === bug.id ? 'secondary' : 'ghost'}
							aria-label={cardEditBugId === bug.id ? `Cancel editing ${bug.title}` : `Edit ${bug.title}`}
							aria-pressed={cardEditBugId === bug.id}
							onPress={() => setCardEditBugId((current) => current === bug.id ? null : bug.id)}
							className="h-7 min-h-7 w-7 min-w-7"
						>
							<Pencil className="h-3.5 w-3.5" aria-hidden="true" />
						</Button>
					)}
					footerActions={cardEditBugId === bug.id ? undefined : (
						<>
							<Button size="sm" variant="ghost" onPress={() => handleOpenDetails(bug)}>
								<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
								View Bug
							</Button>
							{bug.sourceTaskId ? (
								<Button
									size="sm"
									variant="ghost"
									onPress={() => openWorkspaceRoute(
										{
											pathname: '/tasks',
											search: `?task=${encodeURIComponent(bug.sourceTaskId!)}&view=details`,
											title: 'Related task',
										},
										'split',
									)}
								>
									<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
									View Task
								</Button>
							) : null}
						</>
					)}
				/>
			)}
		/>
	);
	const bugSort = bugViewPreferences.sort?.[0];
	const bugSortLabel = bugSort
		? `${BUG_VIEW_COLUMNS.find((column) => column.id === bugSort.field)?.header ?? bugSort.field} ${bugSort.direction === 'desc' ? '↓' : '↑'}`
		: undefined;
	const bugGridControls = formattingBug ? (
		<RowFormattingToolbar
			label={formattingBug.title}
			value={{
				bold: formattingBug.metadata?.ui?.bold ?? false,
				color: normalizeRowColor(formattingBug.metadata?.ui?.color),
			}}
			onChange={(updates) => handleUpdateBug(formattingBug.id, {
				metadata: {
					...formattingBug.metadata,
					ui: { ...formattingBug.metadata?.ui, ...updates },
				},
			})}
		/>
	) : undefined;
	const handleOpenBugCardEditor = useCallback(() => {
		if (!selectedBug) return;
		void createPersistedCardRoute(presentResourceEditor({
			id: selectedBug.id,
			kind: "bug",
			title: selectedBug.title,
			description: selectedBug.description,
			resourceVersion: selectedBug.updatedAt,
			creator: bugCardCreator(selectedBug),
		})).then((route) => openWorkspaceRoute(route, "action"));
	}, [openWorkspaceRoute, selectedBug]);

	const toggleTagFilter = useCallback((tag: string) => {
		setTagFilter((prev) =>
			prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]
		);
	}, []);

	// Update selected bug when bugs change (keep fields fresh). If the selected
	// bug isn't in the currently loaded list (e.g. it was opened via a deep
	// link and is filtered out or archived), leave it alone instead of closing
	// the sidebar.
	React.useEffect(() => {
		if (!selectedBug) return;
		const latest = bugs.find((bug) => bug.id === selectedBug.id);
		if (latest) setSelectedBug(latest);
	}, [bugs, selectedBug]);

	// Deep-link support: `/bugs?bug=<id>` (e.g. from the command palette search
	// results) opens the details sidebar for that bug directly. Falls back to a
	// direct fetch when the bug isn't part of the currently loaded list (e.g. it
	// is archived).
	React.useEffect(() => {
		const bugId = searchParams.get('bug');
		if (!bugId) {
			setSelectedBug(null);
			return;
		}

		const fromList = bugs.find((bug) => bug.id === bugId);
		if (fromList) {
			setSelectedBug(fromList);
			return;
		}

		let cancelled = false;
		api
			.getBug(bugId)
			.then((response) => {
				if (!cancelled) setSelectedBug(response.bug);
			})
			.catch(() => {
				// Bug no longer exists or failed to load; leave selection as-is.
			});
		return () => {
			cancelled = true;
		};
	}, [bugs, searchParams]);

	// Handle WebSocket messages for real-time updates
	const handleWSMessage = useCallback(
		(msg: WebSocketMessage) => {
			if (msg.channel !== 'bugs' || !msg.event) return;

			switch (msg.event) {
				case 'bug.created':
				case 'bug.updated':
				case 'bug.deleted':
					// Invalidate queries to trigger refetch
					queryClient.invalidateQueries({ queryKey: bugsKeys.all() });
					setBurndownRefresh((current) => current + 1);
					break;
			}
		},
		[queryClient]
	);

	// Subscribe to bugs channel
	useWebSocket({
		channels: ['bugs'],
		onMessage: handleWSMessage,
	});

	const openNewBugPanel = useCallback(() => {
		openWorkspaceRoute(
			{ pathname: '/bugs', search: '?new=1', title: 'New Bug' },
			'action',
		);
	}, [openWorkspaceRoute]);

	if (isNewBugPage) {
		return (
			<BugModal
				isOpen
				presentation="panel"
				onClose={closeWorkspaceRoute}
				onSaved={() => {
					void refetch();
				}}
			/>
		);
	}

	if (selectedBug && searchParams.has('bug')) {
		return (
			<BugDetailProjection
				bug={selectedBug}
				onClose={isWorkspacePanel ? undefined : closeWorkspaceRoute}
				onUpdate={handleUpdateBug}
				onOpenCardEditor={handleOpenBugCardEditor}
			/>
		);
	}

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<SheetWorkspaceToolbar
				screenId="bugs"
				resourceKey="bug"
				resourceName="Bugs"
				searchText={searchText}
				onSearchTextChange={setSearchText}
				searchPlaceholder="Search bugs…"
				total={bugs.length}
				visible={filteredBugs.length}
				activeInsight={activeInsight}
				onInsightChange={setActiveInsight}
				onRefresh={() => {
					void refetch();
				}}
				onNew={openNewBugPanel}
				display={display}
				onDisplayChange={updateDisplay}
				onConfigure={() => setConfiguringView(true)}
				filterCount={bugViewPreferences.filters?.length ?? 0}
				sortLabel={bugSortLabel}
				extensionWidgets={{
					"bugs.tag-filters": availableTags.length > 0 ? (
						<div className="flex shrink-0 items-center gap-1" aria-label="Bug tag filters">
							<Tag className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
							{availableTags.slice(0, 8).map((tag) => (
								<button
									key={tag}
									type="button"
									aria-pressed={tagFilter.includes(tag)}
									onClick={() => toggleTagFilter(tag)}
									className={cn(
										"h-7 shrink-0 touch-manipulation border px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
										tagFilter.includes(tag)
											? "border-accent/50 bg-accent/10 text-accent"
											: "border-border text-muted-foreground hover:bg-surface-secondary hover:text-foreground",
									)}
								>
									{tag}
								</button>
							))}
							{tagFilter.length > 0 ? (
								<Button size="sm" variant="ghost" onPress={() => setTagFilter([])}>
									Clear
								</Button>
							) : null}
						</div>
					) : null,
					"bugs.row-formatting": display.mode === "grid" ? bugGridControls : null,
				}}
			/>

			{isError && error ? (
				<div role="alert" className="flex shrink-0 items-center gap-2 border-b border-danger/20 bg-danger/10 px-4 py-2 text-sm text-danger">
					<AlertTriangle className="h-4 w-4" aria-hidden="true" />
					<span>{error.message}</span>
				</div>
			) : null}

			<BugInsightPanel
				activeInsight={activeInsight}
				bugs={bugs}
				burndownRefresh={burndownRefresh}
				onOpenBug={handleOpenDetails}
			/>

			<div className="min-h-0 flex-1 overflow-hidden">
				{isLoading ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground" role="status">
						Loading bugs…
					</div>
				) : display.mode === 'cards' ? (
					bugCardCollection
				) : (
					<React.Suspense fallback={<div className="p-5 text-sm text-muted-foreground">Loading spreadsheet…</div>}>
						<BugSheet
							bugs={filteredBugs}
							selectedBugId={undefined}
							onOpenDetails={handleOpenDetails}
							onUpdateBug={handleUpdateBug}
							onDelete={handleDeleteBug}
							onCreateBugAt={handleCreateBugAt}
							onRowsMove={handleRowsMove}
							density={display.density}
							viewPreferences={bugViewPreferences}
							onViewPreferencesChange={bugView.updatePreferences}
							onSelectedBugChange={setFormattingBug}
						/>
					</React.Suspense>
				)}
			</div>
			<ViewConfigurator
				open={configuringView}
				columns={BUG_VIEW_COLUMNS}
				preferences={bugViewPreferences}
				shared={bugView.view.shared}
				onChange={bugView.updatePreferences}
				onSharedChange={(shared) => void bugView.updateShared(shared)}
				onClose={() => setConfiguringView(false)}
			/>
		</div>
	);
}
