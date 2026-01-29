/**
 * Bugs Hook - React Query Integration
 * 
 * Provides queries and mutations for bug tracking with optimistic updates.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Bug } from '@/lib/api';
import { bugsKeys } from '@/lib/queryKeys';
import { useToast } from '@/hooks/useToast';

// Types
interface BugFilters {
  source?: string;
  status?: string;
  priority?: string;
  assignee?: string;
}

interface CreateBugVariables {
  title: string;
  description: string;
  source: "arm_reported" | "human_reported" | "system_detected";
  sourceTaskId?: string;
  priority?: "low" | "medium" | "high" | "critical";
  errorDetails?: string;
  metadata?: Record<string, unknown>;
}

interface UpdateBugVariables {
  id: string;
  updates: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    assigneeArmId?: string;
    blockers?: string[];
    resolution?: string;
    humanNotified?: boolean;
    metadata?: Record<string, unknown>;
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

  const bugsQuery = useQuery({
    queryKey: bugsKeys.list(filters ?? {}),
    queryFn: async () => {
      const response = await api.listBugs(filters);
      return response.bugs;
    },
  });

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
      const previousBugs = queryClient.getQueryData(bugsKeys.list(filters ?? {}));
      const previousStats = queryClient.getQueryData(bugsKeys.stats());

      // Optimistically update the bug list
      queryClient.setQueryData(
        bugsKeys.list(filters ?? {}),
        (old: Bug[] | undefined) => {
          if (!old) return old;
          return old.map((bug) => (bug.id === id ? { ...bug, ...updates } : bug));
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
      const previousBugs = queryClient.getQueryData(bugsKeys.list(filters ?? {}));

      queryClient.setQueryData(
        bugsKeys.list(filters ?? {}),
        (old: Bug[] | undefined) => {
          if (!old) return old;
          return old.filter((bug) => bug.id !== id);
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

      const previousData = queryClient.getQueryData(bugsKeys.list(filters ?? {}));

      queryClient.setQueryData(
        bugsKeys.list(filters ?? {}),
        (old: Bug[] | undefined) => {
          if (!old) return old;
          
          // Sort bugs by sortOrder to get proper order for optimistic update
          const bugs = [...old].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
          const fromIndex = bugs.findIndex(b => (b.sortOrder ?? 0) === fromSortOrder);
          if (fromIndex === -1) return old;
          const [movedBug] = bugs.splice(fromIndex, 1);
          // Calculate target index based on toSortOrder
          const toIndex = toSortOrder < 0 ? bugs.length : Math.min(toSortOrder, bugs.length);
          bugs.splice(toIndex, 0, movedBug);
          // Update sortOrder values
          bugs.forEach((bug, i) => {
            bug.sortOrder = i;
          });
          
          return bugs;
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
    bugs: bugsQuery.data ?? [],
    stats: statsQuery.data,
    isLoading: bugsQuery.isLoading,
    isError: bugsQuery.isError,
    error: bugsQuery.error,
    refetch: bugsQuery.refetch,

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
