/**
 * Bugs Hook - React Query Integration
 * 
 * Provides queries and mutations for bug tracking with optimistic updates.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, type Bug, type BugMetadata } from '@/lib/api';
import { bugsKeys } from '@/lib/queryKeys';
import { useToast } from '@/hooks/useToast';

import type { ProjectionFilter } from '@/workbench/types';

// Types
interface BugFilters {
  source?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  search?: string;
  tags?: string[];
  viewFilters?: ProjectionFilter[];
}

type BugListResponse = Awaited<ReturnType<typeof api.listBugs>>;
type BugListQueryData = InfiniteData<BugListResponse>;

const PAGE_SIZE = 100;

interface CreateBugVariables {
  title: string;
  description: string;
  source: Bug['source'];
  sourceTaskId?: string;
  priority?: Bug['priority'];
  errorDetails?: string;
  metadata?: BugMetadata;
}

interface UpdateBugVariables {
  id: string;
  updates: {
    title?: string;
    description?: string;
    status?: Bug['status'];
    priority?: Bug['priority'];
    assigneeArmId?: string;
    blockers?: string[];
    resolution?: string;
    humanNotified?: boolean;
    metadata?: BugMetadata;
  };
}

interface ReorderBugVariables {
  bugId: string;
  fromSortOrder: number;
  toSortOrder: number;
}

export function useBugs(filters?: BugFilters) {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const bugsQuery = useInfiniteQuery({
    queryKey: bugsKeys.list(filters ?? {}),
    queryFn: ({ pageParam = 0, signal }) => api.listBugs({
      ...filters,
      limit: PAGE_SIZE,
      offset: pageParam,
    }, signal),
    getNextPageParam: (lastPage) => {
      const { offset, limit, total } = lastPage.pagination;
      const nextOffset = offset + limit;
      return nextOffset < total ? nextOffset : undefined;
    },
    initialPageParam: 0,
  });
  const bugs = useMemo(
    () => bugsQuery.data?.pages.flatMap((page) => page.bugs) ?? [],
    [bugsQuery.data],
  );
  const pagination = bugsQuery.data?.pages[0]?.pagination;
  const searchMatches = bugsQuery.data?.pages[0]?.searchMatches;

  const statsQuery = useQuery({
    queryKey: bugsKeys.stats(),
    queryFn: async () => {
      const response = await api.getBugStats();
      return response;
    },
  });

  const createBugMutation = useMutation({
    mutationFn: async (data: CreateBugVariables) => {
      const response = await api.createBug(data);
      return response.bug;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bugsKeys.all() });
    },
    onError: (err) => {
      showError(`Failed to create bug: ${err.message}`, 'Create Failed');
    },
  });

  const updateBugMutation = useMutation({
    mutationFn: async ({ id, updates }: UpdateBugVariables) => {
      await api.updateBug(id, updates);
    },
    onMutate: async ({ id, updates }) => {
      await queryClient.cancelQueries({ queryKey: bugsKeys.all() });
      const previousBugs = queryClient.getQueryData<BugListQueryData>(bugsKeys.list(filters ?? {}));
      const previousStats = queryClient.getQueryData<{ byStatus: Record<string, number> }>(bugsKeys.stats());

      // Optimistically update the bug list
      queryClient.setQueryData(
        bugsKeys.list(filters ?? {}),
        (old: BugListQueryData | undefined) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              bugs: page.bugs.map((bug) => (bug.id === id ? { ...bug, ...updates } : bug)),
            })),
          };
        }
      );

      // Optimistically update stats if status changed
      if (updates.status) {
        queryClient.setQueryData(bugsKeys.stats(), (old: { byStatus: Record<string, number> } | undefined) => {
          if (!old) return old;
          // Note: This is a simplified update - actual stats would need to know the previous status
          return old;
        });
      }

      return { previousBugs, previousStats };
    },
    onError: (err, _variables, context) => {
      if (context?.previousBugs) {
        queryClient.setQueryData(bugsKeys.list(filters ?? {}), context.previousBugs);
      }
      if (context?.previousStats) {
        queryClient.setQueryData(bugsKeys.stats(), context.previousStats);
      }
      showError(`Failed to update bug: ${err.message}`, 'Update Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: bugsKeys.all() });
    },
  });

  const deleteBugMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.deleteBug(id);
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: bugsKeys.all() });
      const previousBugs = queryClient.getQueryData<BugListQueryData>(bugsKeys.list(filters ?? {}));

      queryClient.setQueryData(
        bugsKeys.list(filters ?? {}),
        (old: BugListQueryData | undefined) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              bugs: page.bugs.filter((bug) => bug.id !== id),
            })),
          };
        }
      );

      return { previousBugs };
    },
    onError: (err, _id, context) => {
      if (context?.previousBugs) {
        queryClient.setQueryData(bugsKeys.list(filters ?? {}), context.previousBugs);
      }
      showError(`Failed to delete bug: ${err.message}`, 'Delete Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: bugsKeys.all() });
    },
  });

  // Mutation: Reorder bug with optimistic update
  const reorderBugMutation = useMutation({
    mutationFn: async ({ bugId, toSortOrder }: ReorderBugVariables) => {
      await api.reorderBug(bugId, toSortOrder);
    },
    onMutate: async ({ toSortOrder, fromSortOrder }) => {
      await queryClient.cancelQueries({ queryKey: bugsKeys.all() });

      const previousData = queryClient.getQueryData<BugListQueryData>(bugsKeys.list(filters ?? {}));

      queryClient.setQueryData(
        bugsKeys.list(filters ?? {}),
        (old: BugListQueryData | undefined) => {
          if (!old) return old;
          const pages = old.pages.map((page) => ({ ...page, bugs: [...page.bugs] }));
          const allBugs = pages.flatMap((page) => page.bugs);
          // Sort bugs by sortOrder to get proper order for optimistic update
          const reordered = allBugs.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
          const fromIndex = reordered.findIndex(b => (b.sortOrder ?? 0) === fromSortOrder);
          if (fromIndex === -1) return old;
          const [movedBug] = reordered.splice(fromIndex, 1);
          if (!movedBug) return old;
          // Calculate target index based on toSortOrder
          const toIndex = toSortOrder < 0 ? reordered.length : Math.min(toSortOrder, reordered.length);
          reordered.splice(toIndex, 0, movedBug);
          // Update sortOrder values
          reordered.forEach((bug, i) => {
            bug.sortOrder = i;
          });
          let cursor = 0;
          return {
            ...old,
            pages: pages.map((page) => {
              const nextBugs = reordered.slice(cursor, cursor + page.bugs.length);
              cursor += page.bugs.length;
              return { ...page, bugs: nextBugs };
            }),
          };
        }
      );

      return { previousData };
    },
    onError: (err, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(bugsKeys.list(filters ?? {}), context.previousData);
      }
      showError(`Failed to reorder bug: ${err.message}`, 'Reorder Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: bugsKeys.all() });
    },
  });

  return {
    bugs,
    pagination,
    searchMatches,
    stats: statsQuery.data,
    isLoading: bugsQuery.isLoading,
    isError: bugsQuery.isError,
    error: bugsQuery.error,
    refetch: bugsQuery.refetch,
    hasNextPage: bugsQuery.hasNextPage,
    isFetchingNextPage: bugsQuery.isFetchingNextPage,
    fetchNextPage: bugsQuery.fetchNextPage,

    createBug: createBugMutation.mutate,
    createBugAsync: createBugMutation.mutateAsync,
    isCreating: createBugMutation.isPending,

    updateBug: updateBugMutation.mutate,
    updateBugAsync: updateBugMutation.mutateAsync,
    isUpdating: updateBugMutation.isPending,

    deleteBug: deleteBugMutation.mutate,
    deleteBugAsync: deleteBugMutation.mutateAsync,
    isDeleting: deleteBugMutation.isPending,

    reorderBug: reorderBugMutation.mutate,
    reorderBugAsync: reorderBugMutation.mutateAsync,
    isReordering: reorderBugMutation.isPending,
  };
}

export function useBug(bugId: string | null) {
  return useQuery({
    queryKey: bugsKeys.detail(bugId ?? ''),
    queryFn: async () => {
      if (!bugId) throw new Error('Bug ID required');
      const response = await api.getBug(bugId);
      return response.bug;
    },
    enabled: !!bugId,
    retry: false,
  });
}
