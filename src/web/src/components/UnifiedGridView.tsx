import { type ChangeEvent, useState, useMemo, useCallback, useDeferredValue } from 'react';
import { RefreshCw, Settings, Grid3x3, ListTree, ListTodo, Search, Lightbulb } from 'lucide-react';
import { Button, Tabs, Chip } from '@heroui/react';
import { TaskGrid } from './TaskGrid';
import { DiscoveryGrid } from './DiscoveryGrid';
import { type Task, type Discovery, cn } from '@/lib';
import { useTasks } from '@/hooks/useTasks';
import { useDiscoveries, useInfiniteDiscoveries } from '@/hooks/useDiscoveries';

type TabType = 'plan-items' | 'tasks' | 'discoveries';

interface UnifiedGridViewProps {
  className?: string;
}

export function UnifiedGridView({ className }: UnifiedGridViewProps) {
  const planItemsId: TabType = 'plan-items';
  const tasksId: TabType = 'tasks';
  const discoveriesId: TabType = 'discoveries';
  const [activeTab, setActiveTab] = useState<TabType>('plan-items');
  const [searchText, setSearchText] = useState('');
  const deferredSearchText = useDeferredValue(searchText);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [selectedDiscoveryId, setSelectedDiscoveryId] = useState<string | undefined>();

  const tasksResult = useTasks();
  const { tasks, isLoading: tasksLoading, refetch: refetchTasks } = tasksResult;
	const planItems = useTasks({ sourceType: 'plan' });
	const discoveriesResult = useInfiniteDiscoveries({ status: 'all' });
	const discoveriesMutation = useDiscoveries({ status: 'all' });
	const { discoveries, isLoading: discoveriesLoading, refetch: refetchDiscoveries } = discoveriesResult;

  const filteredTasks = useMemo(() => {
    if (!deferredSearchText.trim()) return tasks;
    const search = deferredSearchText.toLowerCase();
    return tasks.filter(task =>
      task.subject.toLowerCase().includes(search) ||
      task.description.toLowerCase().includes(search) ||
      task.phase?.toLowerCase().includes(search)
    );
  }, [tasks, deferredSearchText]);

  const filteredPlanItems = useMemo(() => {
    if (!deferredSearchText.trim()) return planItems.tasks;
    const search = deferredSearchText.toLowerCase();
    return planItems.tasks.filter(task =>
      task.subject.toLowerCase().includes(search) ||
      task.description.toLowerCase().includes(search) ||
      task.phase?.toLowerCase().includes(search)
    );
  }, [planItems.tasks, deferredSearchText]);

  const filteredDiscoveries = useMemo(() => {
    if (!deferredSearchText.trim()) return discoveries;
    const search = deferredSearchText.toLowerCase();
    return discoveries.filter(discovery =>
      discovery.title.toLowerCase().includes(search) ||
      discovery.details.toLowerCase().includes(search)
    );
  }, [discoveries, deferredSearchText]);

  const handleOpenTaskDetails = useCallback((task: Task) => {
    setSelectedTaskId(task.id);
  }, []);

  const handleOpenDiscoveryDetails = useCallback((discovery: Discovery) => {
    setSelectedDiscoveryId(discovery.id);
  }, []);

  const handleRefresh = useCallback(() => {
    if (activeTab === 'plan-items') planItems.refetch();
    if (activeTab === 'tasks') refetchTasks();
    if (activeTab === 'discoveries') refetchDiscoveries();
  }, [activeTab, planItems, refetchTasks, refetchDiscoveries]);

	const handleSearch = (e: ChangeEvent<HTMLInputElement>) => {
		setSearchText(e.target.value);
	};

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="px-4 py-3 border-b">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Grid3x3 className="h-5 w-5 text-accent" />
              <h1 className="text-lg font-semibold">Planning Grid</h1>
          </div>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={handleRefresh}
            aria-label="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-default-400" />
            <input
              type="text"
              placeholder="Search..."
              value={searchText}
              onChange={handleSearch}
              className="pl-8 pr-3 py-1.5 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent max-w-md w-full"
            />
          </div>
          <Button size="sm" variant="ghost" isIconOnly>
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <Tabs
          selectedKey={activeTab}
          onSelectionChange={(key) => setActiveTab(key as TabType)}
          className="h-full flex flex-col"
        >
          <Tabs.ListContainer className="flex-shrink-0 border-b">
            <Tabs.List aria-label="Grid view tabs" className="w-full">
              <Tabs.Tab id={planItemsId} className="flex-1">
                <ListTree className="h-4 w-4" />
                Plan Items
                <Tabs.Indicator />
                <Chip size="sm" variant="soft" className="ml-1">
                  {planItems.pagination?.total ?? planItems.tasks.length}
                </Chip>
              </Tabs.Tab>
              <Tabs.Tab id={tasksId} className="flex-1">
                <ListTodo className="h-4 w-4" />
                Tasks
                <Tabs.Indicator />
                <Chip size="sm" variant="soft" className="ml-1">
                  {tasks.length}
                </Chip>
              </Tabs.Tab>
              <Tabs.Tab id={discoveriesId} className="flex-1">
                <Lightbulb className="h-4 w-4" />
                Discoveries
                <Tabs.Indicator />
                <Chip size="sm" variant="soft" className="ml-1">
                  {discoveries.length}
                </Chip>
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>

          <Tabs.Panel id={planItemsId} className="flex-1 overflow-hidden p-0">
            <div className="p-4 h-full overflow-auto">
              {planItems.isLoading ? (
                <div className="text-center p-8 text-muted-foreground">Loading plan items...</div>
              ) : (
                <TaskGrid
                  tasks={filteredPlanItems}
                  totalTasks={planItems.pagination?.total}
                  selectedTaskId={selectedTaskId}
                  onOpenDetails={handleOpenTaskDetails}
                  hasNextPage={planItems.hasNextPage}
                  isFetchingNextPage={planItems.isFetchingNextPage}
                  onLoadMore={planItems.fetchNextPage}
                  className="h-full"
                />
              )}
            </div>
          </Tabs.Panel>

          <Tabs.Panel id={tasksId} className="flex-1 overflow-hidden p-0">
            <div className="p-4 h-full overflow-auto">
              {tasksLoading ? (
                <div className="text-center p-8 text-muted-foreground">Loading tasks...</div>
              ) : (
                <TaskGrid
                  tasks={filteredTasks}
                  totalTasks={tasksResult.pagination?.total}
                  selectedTaskId={selectedTaskId}
                  onOpenDetails={handleOpenTaskDetails}
                  hasNextPage={tasksResult.hasNextPage}
                  isFetchingNextPage={tasksResult.isFetchingNextPage}
                  onLoadMore={tasksResult.fetchNextPage}
                  className="h-full"
                />
              )}
            </div>
          </Tabs.Panel>

          <Tabs.Panel id={discoveriesId} className="flex-1 overflow-hidden p-0">
            <div className="p-4 h-full overflow-auto">
              {discoveriesLoading ? (
                <div className="text-center p-8 text-muted-foreground">Loading discoveries...</div>
              ) : (
						<DiscoveryGrid
							discoveries={filteredDiscoveries}
							selectedDiscoveryId={selectedDiscoveryId}
							onOpenDetails={handleOpenDiscoveryDetails}
							onUpdateDiscovery={(discoveryId, updates) =>
								discoveriesMutation.updateDiscovery({ id: discoveryId, updates })
							}
							hasNextPage={discoveriesResult.hasNextPage}
							isFetchingNextPage={discoveriesResult.isFetchingNextPage}
							onLoadMore={discoveriesResult.fetchNextPage}
							className="h-full"
                />
              )}
            </div>
          </Tabs.Panel>
        </Tabs>
      </div>
    </div>
  );
}
