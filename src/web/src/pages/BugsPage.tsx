/**
 * Bugs Page
 *
 * Displays bug reports and allows tracking and management
 * Uses React Query for data fetching with optimistic updates
 */
import React, { useMemo, useState, useCallback, useId } from 'react';
import { Plus, RefreshCw, AlertTriangle, Tag, X, Search, FileText, Bug as BugIcon } from 'lucide-react';
import { Button, Chip, Card, Tabs } from '@heroui/react';
import { type Bug, cn } from '@/lib';
import { BugGrid, BugModal } from '@/components';
import type { BugUpdate } from '@/components/BugGridRow';
import { useBugs } from '@/hooks/useBugs';
import { useQueryClient } from '@tanstack/react-query';
import { bugsKeys } from '@/lib/queryKeys';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useWebSocket } from '@/hooks/useWebSocket';

type SidebarTab = 'details';

type BugUiMeta = {
	tags?: string[];
	color?: string;
	bold?: boolean;
};

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

export function BugsPage() {
  usePageTitle('Coleo Observatory - Bugs');

  const queryClient = useQueryClient();
	const [filter, setFilter] = useState<{ status?: string; priority?: string; source?: string }>({});
	const [tagFilter, setTagFilter] = useState<string[]>([]);
	const [searchText, setSearchText] = useState('');
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [selectedBug, setSelectedBug] = useState<Bug | null>(null);
	const [sidebarTab, setSidebarTab] = useState<SidebarTab>('details');
	const detailsTabId = useId();

	// Use React Query hook for bugs
	const {
		bugs,
		stats,
		isLoading,
		isError,
		error,
		refetch,
		updateBug,
		createBug,
		deleteBug,
		reorderBug,
	} = useBugs(filter);

	const getBugUiMeta = useCallback((bug: Bug): BugUiMeta => {
		const meta = (bug.metadata ?? {}) as Record<string, unknown>;
		const ui = (meta.ui ?? {}) as Record<string, unknown>;
		return {
			tags: Array.isArray(ui.tags) ? (ui.tags as string[]) : [],
			color: typeof ui.color === 'string' ? (ui.color as string) : 'slate',
			bold: Boolean(ui.bold),
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
			const nextMetadata = {
				...(target.metadata ?? {}),
				ui: nextUi,
			} as Record<string, unknown>;

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

	// Update selected bug when bugs change
	React.useEffect(() => {
		if (!selectedBug) return;
		const latest = bugs.find((bug) => bug.id === selectedBug.id) || null;
		setSelectedBug(latest);
	}, [bugs, selectedBug]);

	// Handle WebSocket messages for real-time updates
	const handleWSMessage = useCallback(
		(msg: { channel?: string; event?: string; data?: unknown }) => {
			if (msg.channel !== 'bugs' || !msg.event || !msg.data) return;

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

	return (
		<div className="flex flex-col h-full">
			{/* Header with filters and actions */}
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
							onPress={() => {
								setIsModalOpen(true);
							}}
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
					<div className="h-4 w-px bg-divider" />
					<div className="flex items-center gap-2 flex-wrap">
						{Object.entries(stats?.byStatus ?? {}).map(([status, count]) => (
							<Button
								key={status}
								size="sm"
								variant={filter.status === status ? 'primary' : 'ghost'}
								onPress={() =>
									setFilter((f) =>
										f.status === status ? {} : { ...f, status }
									)
								}
								className="h-7"
							>
								<span
									className={
										filter.status === status
											? ''
											: STATUS_CONFIG[status as Bug['status']]?.color ||
											  'text-foreground-500'
									}
								>
									{status.replace('_', ' ')}
								</span>
								<span>{count}</span>
							</Button>
						))}
						{filter.status && (
							<Button size="sm" variant="ghost" onPress={() => setFilter({})}>
								Clear filter
							</Button>
						)}
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
						<div className="p-4">
							<BugGrid
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
							onSelectionChange={(key) => setSidebarTab(key as SidebarTab)}
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
										<div>
											<span className="text-xs text-foreground-500 font-mono">
												ID: {selectedBug.id}
											</span>
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
											<p className="text-sm">{selectedBug.description}</p>
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

										<div className="text-xs text-foreground-500"
										>
											Created{' '}
											{new Date(selectedBug.createdAt).toLocaleString()}
										</div>
									</div>
								</div>
							</Tabs.Panel>
						</Tabs>
				</Card>
			)}
		</div>

		<BugModal
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			onSaved={() => refetch()}
		/>
	</div>
	);
}
