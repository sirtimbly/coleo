import { useState, useMemo, useCallback, useId } from 'react';
import { RefreshCw, Settings, Grid3x3, ListTodo, Search, Lightbulb } from 'lucide-react';
import { Button, Tabs, Chip } from '@heroui/react';
import { TaskGrid } from './TaskGrid';
import { BugGrid } from './BugGrid';
import { DiscoveryGrid } from './DiscoveryGrid';
import { type Task, type Bug, type Discovery, cn } from '@/lib';
import { useTasks } from '@/hooks/useTasks';
import { useBugs } from '@/hooks/useBugs';
import { useDiscoveries } from '@/hooks/useDiscoveries';

type TabType = 'tasks' | 'bugs' | 'discoveries';

interface UnifiedGridViewProps {
  className?: string;
}

export function UnifiedGridView({ className }: UnifiedGridViewProps) {
  const tasksId = useId();
  const bugsId = useId();
  const discoveriesId = useId();
  const [activeTab, setActiveTab] = useState<TabType>('tasks');
  const [searchText, setSearchText] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [selectedBugId, setSelectedBugId] = useState<string | undefined>();
  const [selectedDiscoveryId, setSelectedDiscoveryId] = useState<string | undefined>();

  const { tasks, isLoading: tasksLoading, refetch: refetchTasks } = useTasks();
  const { bugs, isLoading: bugsLoading, refetch: refetchBugs } = useBugs();
  const { discoveries, isLoading: discoveriesLoading, refetch: refetchDiscoveries } = useDiscoveries({ status: 'open' });

  const filteredTasks = useMemo(() => {
    if (!searchText.trim()) return tasks;
    const search = searchText.toLowerCase();
    return tasks.filter(task =>
      task.subject.toLowerCase().includes(search) ||
      task.description.toLowerCase().includes(search) ||
      task.phase?.toLowerCase().includes(search)
    );
  }, [tasks, searchText]);

  const filteredBugs = useMemo(() => {
    if (!searchText.trim()) return bugs;
    const search = searchText.toLowerCase();
    return bugs.filter(bug =>
      bug.title.toLowerCase().includes(search) ||
      bug.description.toLowerCase().includes(search)
    );
  }, [bugs, searchText]);

  const filteredDiscoveries = useMemo(() => {
    if (!searchText.trim()) return discoveries;
    const search = searchText.toLowerCase();
    return discoveries.filter(discovery =>
      discovery.title.toLowerCase().includes(search) ||
      discovery.details.toLowerCase().includes(search)
    );
  }, [discoveries, searchText]);

  const handleOpenTaskDetails = useCallback((task: Task) => {
    setSelectedTaskId(task.id);
  }, []);

  const handleOpenBugDetails = useCallback((bug: Bug) => {
    setSelectedBugId(bug.id);
  }, []);

  const handleOpenDiscoveryDetails = useCallback((discovery: Discovery) => {
    setSelectedDiscoveryId(discovery.id);
  }, []);

  const handleRefresh = useCallback(() => {
    if (activeTab === 'tasks') refetchTasks();
    if (activeTab === 'bugs') refetchBugs();
    if (activeTab === 'discoveries') refetchDiscoveries();
  }, [activeTab, refetchTasks, refetchBugs, refetchDiscoveries]);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchText(e.target.value);
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="px-4 py-3 border-b">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Grid3x3 className="h-5 w-5 text-accent" />
            <h1 className="text-lg font-semibold">Unified Grid View</h1>
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
              <Tabs.Tab id={tasksId} className="flex-1">
                <ListTodo className="h-4 w-4" />
                Tasks
                <Tabs.Indicator />
                <Chip size="sm" variant="soft" className="ml-1">
                  {tasks.length}
                </Chip>
              </Tabs.Tab>
              <Tabs.Tab id={bugsId} className="flex-1">
                <Search className="h-4 w-4" />
                Bugs
                <Tabs.Indicator />
                <Chip size="sm" variant="soft" className="ml-1">
                  {bugs.length}
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

          <Tabs.Panel id={tasksId} className="flex-1 overflow-hidden p-0">
            <div className="p-4 h-full overflow-auto">
              {tasksLoading ? (
                <div className="text-center p-8 text-muted-foreground">Loading tasks...</div>
              ) : (
                <TaskGrid
                  tasks={filteredTasks}
                  totalTasks={tasks.length}
                  selectedTaskId={selectedTaskId}
                  onOpenDetails={handleOpenTaskDetails}
                  className="h-full"
                />
              )}
            </div>
          </Tabs.Panel>

          <Tabs.Panel id={bugsId} className="flex-1 overflow-hidden p-0">
            <div className="p-4 h-full overflow-auto">
              {bugsLoading ? (
                <div className="text-center p-8 text-muted-foreground">Loading bugs...</div>
              ) : (
                <BugGrid
                  bugs={filteredBugs}
                  totalBugs={bugs.length}
                  selectedBugId={selectedBugId}
                  onOpenDetails={handleOpenBugDetails}
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