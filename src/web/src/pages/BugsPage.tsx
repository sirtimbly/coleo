/**
 * Bugs Page
 *
 * Displays bug reports and allows tracking and management
 * Uses React Query for data fetching with optimistic updates
 */
import React, { useMemo, useState, useCallback } from 'react';
import { Plus, RefreshCw, AlertTriangle, Tag, X, Search, FileText, Bug as BugIcon, Clock } from 'lucide-react';
import { Button, Chip, Card, Tabs } from '@heroui/react';
import { type Bug, type BugMetadata, type UiMetadata, cn, api } from '@/lib';
import { BugGrid, BugModal } from '@/components';
import type { BugUpdate } from '@/components/BugGridRow';
import { useBugs } from '@/hooks/useBugs';
import { useQueryClient } from '@tanstack/react-query';
import { bugsKeys } from '@/lib/queryKeys';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import {
	useIsWorkspacePanel,
	useWorkspaceCloseRoute,
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from '@/workspace/route-context';

type SidebarTab = 'details';

type BugUiMeta = UiMetadata;

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
			<Clock className="h-3 w-3" />
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
					placeholder="Add a description for this bug..."
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
	const [sidebarTab, setSidebarTab] = useState<SidebarTab>('details');
	const detailsTabId: SidebarTab = "details";

	// Use React Query hook for bugs
	const {
		bugs,
		isLoading,
		isError,
		error,
		refetch,
		updateBug,
		createBug,
		deleteBug,
		reorderBug,
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

		if (searchText.trim()) {
			const search = searchText.toLowerCase();
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

		return result;
	}, [bugs, tagFilter, searchText, getBugUiMeta]);

	const handleUpdateBug = useCallback(
		async (bugId: string, updates: BugUpdate) => {
			// Optimistic update is handled by the mutation
			updateBug({ id: bugId, updates });
		},
		[updateBug]
	);

	const handleUpdateUi = useCallback(
		async (bugId: string, updates: BugUiMeta) => {
			const target = bugs.find((bug) => bug.id === bugId);
			if (!target) return;
			const currentUi = getBugUiMeta(target);
			const nextUi: BugUiMeta = {
				...currentUi,
				...updates,
				tags: updates.tags ?? currentUi.tags,
			};
			const nextMetadata: BugMetadata = {
				...target.metadata,
				ui: nextUi,
			};

			updateBug({ id: bugId, updates: { metadata: nextMetadata } });
		},
		[bugs, getBugUiMeta, updateBug]
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
		async (_index: number, title: string) => {
			try {
				await createBug({
					title,
					description: title,
					source: 'human_reported',
					priority: 'medium',
				});
			} catch {
				// Error is handled by the mutation
			}
		},
		[createBug]
	);

	const handleReorder = useCallback(
		(bugId: string, fromSortOrder: number, toSortOrder: number) => {
			if (!bugId) return;
			reorderBug({ bugId, fromSortOrder, toSortOrder });
		},
		[reorderBug]
	);

	const handleOpenDetails = useCallback((bug: Bug) => {
		setSelectedBug(bug);
		setSidebarTab('details');
	}, []);

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
		if (!isWorkspacePanel) return;

		const bugId = searchParams.get('bug');
		if (!bugId) return;

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
	}, [bugs, isWorkspacePanel, searchParams]);

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

	const openNewBugPanel = () => {
		openWorkspaceRoute(
			{ pathname: '/bugs', search: '?new=1', title: 'New Bug' },
			'action',
		);
	};

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

	const workspaceHeader = (
		<header className="flex items-center gap-2 border-b border-border bg-background px-3 py-2">
			<div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
				<div className="relative w-48 shrink-0">
					<Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-default-400" />
					<input
						type="text"
						placeholder="Search bugs..."
						value={searchText}
						onChange={(event) => setSearchText(event.target.value)}
						className="h-9 w-full rounded-md border border-border bg-surface-secondary px-8 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
					/>
				</div>
				<div className="shrink-0 text-xs text-muted-foreground">{bugs.length} total</div>
				{availableTags.length > 0 ? <div className="h-4 w-px shrink-0 bg-border" /> : null}
				{availableTags.slice(0, 8).map((tag) => (
					<button
						key={tag}
						type="button"
						aria-pressed={tagFilter.includes(tag)}
						onClick={() => toggleTagFilter(tag)}
						className={`h-8 shrink-0 rounded-md border px-2.5 text-xs transition-colors ${
							tagFilter.includes(tag)
								? 'border-accent/50 bg-accent/10 text-accent'
								: 'border-border text-muted-foreground hover:bg-surface-secondary hover:text-foreground'
						}`}
					>
						{tag}
					</button>
				))}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button isIconOnly size="sm" variant="ghost" onPress={() => refetch()} aria-label="Refresh">
					<RefreshCw className="h-4 w-4" />
				</Button>
				<Button size="sm" variant="primary" onPress={openNewBugPanel}>
					<Plus className="mr-1.5 h-4 w-4" />
					New
				</Button>
			</div>
		</header>
	);

	return (
		<div className="flex flex-col h-full">
			{/* Header with filters and actions */}
			{isWorkspacePanel ? workspaceHeader : (
			<div className="border-b px-4 py-3 bg-content2">
				<div className="flex items-center justify-between mb-3">
					<div className="flex items-center space-x-2">
						<BugIcon className="h-5 w-5" />
						<h1 className="text-lg font-semibold">Bugs</h1>
						<span className="text-sm text-foreground-500">Track and manage bug reports</span>
					</div>

					<div className="flex items-center gap-2">
						<Button
							isIconOnly
							variant="ghost"
							onPress={() => refetch()}
							aria-label="Refresh"
						>
							<RefreshCw className="h-4 w-4" />
						</Button>
						<Button
							variant="primary"
							onPress={openNewBugPanel}
						>
							<Plus className="h-4 w-4 mr-2" />
							New Bug
						</Button>
					</div>
				</div>

				{/* Compact filter bar */}
				<div className="flex items-center gap-3">
					<div className="relative">
						<Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-default-400" />
						<input
							type="text"
							placeholder="Search bugs..."
							value={searchText}
							onChange={(e) => setSearchText(e.target.value)}
							className="pl-8 pr-3 py-1.5 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent w-64"
						/>
					</div>
					<div className="h-4 w-px bg-divider" />
					<div className="flex items-center gap-2 text-sm">
						<span className="text-foreground-500">Total:</span>
						<span className="font-medium">{bugs.length}</span>
					</div>
				</div>

				<div className="mt-3 flex items-center gap-2 flex-wrap">
					<div className="flex items-center gap-1 text-xs text-foreground-500">
						<Tag className="h-3.5 w-3.5" />
						<span>Tags</span>
					</div>
					{availableTags.length === 0 ? (
						<span className="text-xs text-foreground-500">No tags yet</span>
					) : (
						availableTags.map((tag) => (
							<Chip
								key={tag}
								size="sm"
								variant={tagFilter.includes(tag) ? 'primary' : 'soft'}
								onClick={() => toggleTagFilter(tag)}
								className="cursor-pointer"
							>
								{tag}
							</Chip>
						))
					)}
					{tagFilter.length > 0 && (
						<Button size="sm" variant="ghost" onPress={() => setTagFilter([])}>
							Clear tags
						</Button>
					)}
				</div>
			</div>
			)}

			{isError && error && (
				<div className="p-4 bg-danger/10 text-danger border-b border-danger/20">
					<div className="flex items-center gap-2">
						<AlertTriangle className="h-4 w-4" />
						<span className="text-sm">{error.message}</span>
					</div>
				</div>
			)}

			{/* Content area */}
			<div className="flex-1 flex overflow-hidden">
				{/* Bug list */}
				<div className="flex-1 overflow-auto">
					{isLoading ? (
						<div className="p-4 space-y-4">
							{[1, 2, 3].map((i) => (
								<Card key={i} className="h-24">
									<Card.Content className="animate-pulse bg-default-100" />
								</Card>
							))}
						</div>
					) : (
						<div className={isWorkspacePanel ? undefined : "p-4"}>
							<BugGrid
								className={isWorkspacePanel ? "rounded-none border-0" : undefined}
								bugs={filteredBugs}
								totalBugs={bugs.length}
								availableTags={availableTags}
								selectedBugId={selectedBug?.id}
								onOpenDetails={handleOpenDetails}
								onUpdateBug={handleUpdateBug}
								onUpdateUi={handleUpdateUi}
								onDelete={handleDeleteBug}
								onCreateBugAt={handleCreateBugAt}
								onReorder={handleReorder}
							/>
						</div>
					)}
				</div>

				{/* Bug details sidebar */}
			{selectedBug && (
				<Card className="w-96 border-l rounded-none shadow-none flex flex-col">
						{/* Header with close button */}
						<div className="p-3 border-b flex items-center justify-between flex-shrink-0">
							<h3
								className="font-semibold text-sm truncate max-w-[280px]"
								title={selectedBug.title}
							>
								{selectedBug.title}
							</h3>
							<Button
								isIconOnly
								size="sm"
								variant="ghost"
								onPress={() => setSelectedBug(null)}
								aria-label="Close"
							>
								<X className="h-4 w-4" />
							</Button>
						</div>

						{/* Tabs */}
						<Tabs
							selectedKey={sidebarTab}
							onSelectionChange={(key) => {
								if (key === 'details') {
									setSidebarTab(key);
								}
							}}
							className="flex-1 flex flex-col"
						>
							<Tabs.ListContainer className="flex-shrink-0 border-b"
							>
								<Tabs.List aria-label="Bug tabs" className="w-full"
								>
							<Tabs.Tab id={detailsTabId} className="flex-1"
							>
										<FileText className="h-4 w-4" />
										Details
										<Tabs.Indicator />
									</Tabs.Tab>
								</Tabs.List>
							</Tabs.ListContainer>

						<Tabs.Panel id={detailsTabId} className="flex-1 overflow-hidden p-0"
						>
								<div className="p-4 overflow-auto h-full"
								>
									<div className="space-y-4"
									>
										<div className="flex items-center justify-between">
											<span className="text-xs text-foreground-500 font-mono">
												ID: {selectedBug.id}
											</span>
											<BugCreatedAt createdAt={selectedBug.createdAt} />
										</div>

										<div>
											<span
												className={cn(
													'px-2 py-1 text-xs rounded',
													PRIORITY_CONFIG[selectedBug.priority].bgColor,
													PRIORITY_CONFIG[selectedBug.priority].color
												)}
											>
												{PRIORITY_CONFIG[selectedBug.priority].label}
											</span>
										</div>

										<div>
											<h5 className="text-sm font-medium text-foreground-500 mb-1">
												Description
											</h5>
											<BugDescriptionField
												bugId={selectedBug.id}
												description={selectedBug.description}
												onSave={(bugId, description) => handleUpdateBug(bugId, { description })}
											/>
										</div>

										<div className="grid grid-cols-2 gap-4 text-sm"
										>
											<div>
												<span className="text-foreground-500">Status:</span>
												<div className="flex items-center gap-1 mt-1"
												>
													<span
														className={
															STATUS_CONFIG[selectedBug.status].color
														}
													>
														{STATUS_CONFIG[selectedBug.status].label}
													</span>
												</div>
											</div>
											<div>
												<span className="text-foreground-500">Source:</span>
												<div className="mt-1 capitalize"
												>
													{selectedBug.source.replace('_', ' ')}
												</div>
											</div>
										</div>

										{selectedBug.assigneeArmName && (
											<div>
												<span className="text-sm text-foreground-500">
													Assigned to:
												</span>
												<p className="text-sm font-medium">
													{selectedBug.assigneeArmName}
												</p>
											</div>
										)}
									</div>
								</div>
							</Tabs.Panel>
						</Tabs>
				</Card>
			)}
		</div>

	</div>
	);
}
