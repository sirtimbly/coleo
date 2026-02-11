/**
 * Tasks Hook - React Query Integration with Infinite Loading
 * 
 * Provides infinite loading for task management with:
 * - Automatic pagination and infinite scroll
 * - Optimistic updates for status, priority, tags
 * - Optimistic reordering
 * - Toast notifications on errors
 */

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Task } from '@/lib/api';
import { tasksKeys } from '@/lib/queryKeys';
import { useToast } from '@/hooks/useToast';
import { useMemo } from 'react';

// Types
interface TaskFilters {
  status?: string;
  priority?: string;
  domain?: string;
  assignedTo?: string;
  phase?: string;
}

interface UpdateTaskVariables {
  id: string;
  updates: Partial<Task>;
}

interface ReorderTaskVariables {
  taskId: string;
  toSortOrder: number;
  fromSortOrder: number;
}

interface CreateTaskVariables {
  subject: string;
  description: string;
  priority?: Task['priority'];
  domain?: string;
  phase?: string;
  sourceType?: Task['sourceType'];
  sourceRef?: string;
  dueDate?: string;
  metadata?: Record<string, unknown>;
  sortOrder?: number;
}

const PAGE_SIZE = 100;

// Hook
export function useTasks(filters?: TaskFilters) {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  // Infinite Query: List tasks with filters
  const tasksQuery = useInfiniteQuery({
    queryKey: tasksKeys.list(filters ?? {}),
    queryFn: async ({ pageParam = 0 }) => {
      const response = await api.listTasks({
        ...filters,
        limit: PAGE_SIZE,
        offset: pageParam,
      });
      return response;
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage?.pagination) return undefined;
      const { offset, limit, total } = lastPage.pagination;
      const nextOffset = offset + limit;
      return nextOffset < total ? nextOffset : undefined;
    },
    initialPageParam: 0,
  });

  // Flatten all pages into a single array
  const tasks = useMemo(() => {
    return tasksQuery.data?.pages.flatMap(page => page.tasks) ?? [];
  }, [tasksQuery.data]);

  // Get pagination info from first page
  const pagination = useMemo(() => {
    return tasksQuery.data?.pages[0]?.pagination;
  }, [tasksQuery.data]);

  // Get counts from first page
  const counts = useMemo(() => {
    return tasksQuery.data?.pages[0]?.counts;
  }, [tasksQuery.data]);

  // Check if there are more pages to load
  const hasNextPage = tasksQuery.hasNextPage;
  const isFetchingNextPage = tasksQuery.isFetchingNextPage;

  // Fetch next page
  const fetchNextPage = tasksQuery.fetchNextPage;

  // Mutation: Update task with optimistic update
  const updateTaskMutation = useMutation({
    mutationFn: async ({ id, updates }: UpdateTaskVariables) => {
      const response = await api.updateTask(id, updates as Parameters<typeof api.updateTask>[1]);
      return response.task;
    },
    onMutate: async ({ id, updates }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: tasksKeys.all() });

      // Snapshot previous value
      const previousData = queryClient.getQueryData(tasksKeys.list(filters ?? {}));

      // Optimistically update across all pages
      queryClient.setQueryData(
        tasksKeys.list(filters ?? {}),
        (old: { pages: Array<{ tasks: Task[]; pagination: unknown; counts: unknown }>; pageParams: number[] } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map(page => ({
              ...page,
              tasks: page.tasks.map((task: Task) =>
                task.id === id ? { ...task, ...updates } : task
              ),
            })),
          };
        }
      );

      return { previousData };
    },
    onError: (err, _variables, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClient.setQueryData(tasksKeys.list(filters ?? {}), context.previousData);
      }
      showError(`Failed to update task: ${err.message}`, 'Update Failed');
    },
    onSettled: () => {
      // Always refetch after error or success
      queryClient.invalidateQueries({ queryKey: tasksKeys.all() });
    },
  });

  // Mutation: Reorder task with optimistic update
  const reorderTaskMutation = useMutation({
    mutationFn: async ({ taskId, toSortOrder }: ReorderTaskVariables) => {
      await api.reorderTask(taskId, toSortOrder);
    },
    onMutate: async ({ toSortOrder, fromSortOrder }) => {
      await queryClient.cancelQueries({ queryKey: tasksKeys.all() });

      const previousData = queryClient.getQueryData(tasksKeys.list(filters ?? {}));

      queryClient.setQueryData(
        tasksKeys.list(filters ?? {}),
        (old: { pages: Array<{ tasks: Task[]; pagination: unknown; counts: unknown }>; pageParams: number[] } | undefined) => {
          if (!old) return old;
          
          // Flatten all tasks for reordering
          const allTasks = old.pages.flatMap(page => page.tasks);
          
          // Sort tasks by sortOrder to get proper order for optimistic update
          const tasks = [...allTasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
          const fromIndex = tasks.findIndex(t => (t.sortOrder ?? 0) === fromSortOrder);
          if (fromIndex === -1) return old;
          const [movedTask] = tasks.splice(fromIndex, 1);
          // Calculate target index based on toSortOrder
          const toIndex = toSortOrder < 0 ? tasks.length : Math.min(toSortOrder, tasks.length);
          tasks.splice(toIndex, 0, movedTask);
          // Update sortOrder values
          tasks.forEach((task, i) => {
            task.sortOrder = i;
          });
          
          // Redistribute tasks back to pages
          const newPages = old.pages.map((page, pageIndex) => {
            const start = pageIndex * PAGE_SIZE;
            const end = start + PAGE_SIZE;
            return {
              ...page,
              tasks: tasks.slice(start, end),
            };
          });
          
          return { ...old, pages: newPages };
        }
      );

      return { previousData };
    },
    onError: (err, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(tasksKeys.list(filters ?? {}), context.previousData);
      }
      showError(`Failed to reorder task: ${err.message}`, 'Reorder Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksKeys.all() });
    },
  });

  // Mutation: Create task
  const createTaskMutation = useMutation({
    mutationFn: async (data: CreateTaskVariables) => {
      const response = await api.createTask(data);
      return response.task;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tasksKeys.all() });
    },
    onError: (err) => {
      showError(`Failed to create task: ${err.message}`, 'Create Failed');
    },
  });

  // Mutation: Delete task
  const deleteTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      await api.deleteTask(taskId);
    },
    onMutate: async (taskId) => {
      await queryClient.cancelQueries({ queryKey: tasksKeys.all() });

      const previousData = queryClient.getQueryData(tasksKeys.list(filters ?? {}));

      queryClient.setQueryData(
        tasksKeys.list(filters ?? {}),
        (old: { pages: Array<{ tasks: Task[]; pagination: { total: number }; counts: unknown }>; pageParams: number[] } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map(page => ({
              ...page,
              tasks: page.tasks.filter((task: Task) => task.id !== taskId),
            })),
          };
        }
      );

      return { previousData };
    },
    onError: (err, _taskId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(tasksKeys.list(filters ?? {}), context.previousData);
      }
      showError(`Failed to delete task: ${err.message}`, 'Delete Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tasksKeys.all() });
    },
  });

  // Mutation: Remove task from plan
  const removeFromPlanMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.removeTaskFromPlan(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tasksKeys.all() });
    },
    onError: (err) => {
      showError(`Failed to remove task from plan: ${err.message}`, 'Remove Failed');
    },
  });

  return {
    // Query data
    tasks,
    pagination,
    counts,
    isLoading: tasksQuery.isLoading,
    isError: tasksQuery.isError,
    error: tasksQuery.error,
    refetch: tasksQuery.refetch,
    
    // Infinite loading
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,

    // Mutations
    updateTask: updateTaskMutation.mutate,
    updateTaskAsync: updateTaskMutation.mutateAsync,
    isUpdating: updateTaskMutation.isPending,

    reorderTask: reorderTaskMutation.mutate,
    reorderTaskAsync: reorderTaskMutation.mutateAsync,
    isReordering: reorderTaskMutation.isPending,

    createTask: createTaskMutation.mutate,
    createTaskAsync: createTaskMutation.mutateAsync,
    isCreating: createTaskMutation.isPending,

    deleteTask: deleteTaskMutation.mutate,
    deleteTaskAsync: deleteTaskMutation.mutateAsync,
    isDeleting: deleteTaskMutation.isPending,

    removeFromPlan: removeFromPlanMutation.mutate,
    isRemovingFromPlan: removeFromPlanMutation.isPending,
  };
}

// Hook for single task details
export function useTask(taskId: string | null) {
  return useInfiniteQuery({
    queryKey: tasksKeys.detail(taskId ?? ''),
    queryFn: async () => {
      if (!taskId) throw new Error('Task ID required');
      const response = await api.getTask(taskId);
      return response;
    },
    getNextPageParam: () => undefined,
    initialPageParam: 0,
    enabled: !!taskId,
  });
}
