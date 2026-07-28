/**
 * Discoveries Hook - React Query Integration
 *
 * Provides queries and mutations for discovery management with optimistic updates.
 */

import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Discovery } from '@/lib/api';
import { useToast } from '@/hooks/useToast';

// Types
interface DiscoveryFilters {
  armId?: string;
  kind?: string;
  severity?: string;
  status?: string;
}

const PAGE_SIZE = 100;

interface UpdateDiscoveryVariables {
  id: string;
  updates: {
    status: string;
  };
}

// Query keys factory
export const discoveriesKeys = {
  all: () => ['discoveries'] as const,
  lists: () => [...discoveriesKeys.all(), 'list'] as const,
  list: (filters: DiscoveryFilters) => [...discoveriesKeys.lists(), filters] as const,
  details: () => [...discoveriesKeys.all(), 'detail'] as const,
  detail: (id: string) => [...discoveriesKeys.details(), id] as const,
  stats: () => [...discoveriesKeys.all(), 'stats'] as const,
};

export function useDiscoveries(filters?: DiscoveryFilters) {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const discoveriesQuery = useQuery({
    queryKey: discoveriesKeys.list(filters ?? {}),
    queryFn: async () => {
      const response = await api.listDiscoveries(filters);
      return response.discoveries;
    },
  });

  const statsQuery = useQuery({
    queryKey: discoveriesKeys.stats(),
    queryFn: async () => {
      const response = await api.getDiscoveryStats();
      return response;
    },
  });

  const updateDiscoveryMutation = useMutation({
    mutationFn: async ({ id, updates }: UpdateDiscoveryVariables) => {
      await api.updateDiscovery(id, updates);
    },
    onMutate: async ({ id, updates }) => {
      await queryClient.cancelQueries({ queryKey: discoveriesKeys.all() });
      const previousDiscoveries = queryClient.getQueryData(discoveriesKeys.list(filters ?? {}));
      const previousStats = queryClient.getQueryData(discoveriesKeys.stats());

      // Optimistically update the discovery list
      queryClient.setQueryData(
        discoveriesKeys.list(filters ?? {}),
        (old: Discovery[] | undefined) => {
          if (!old) return old;
          return old.map((discovery) => (discovery.id === id ? { ...discovery, ...updates } : discovery));
        }
      );

      // Optimistically update stats if status changed
      if (updates.status) {
        queryClient.setQueryData(discoveriesKeys.stats(), (old: { byStatus: Record<string, number> } | undefined) => {
          if (!old) return old;
          // Note: This is a simplified update - actual stats would need to know the previous status
          return old;
        });
      }

      return { previousDiscoveries, previousStats };
    },
    onError: (err, _variables, context) => {
      if (context?.previousDiscoveries) {
        queryClient.setQueryData(discoveriesKeys.list(filters ?? {}), context.previousDiscoveries);
      }
      if (context?.previousStats) {
        queryClient.setQueryData(discoveriesKeys.stats(), context.previousStats);
      }
      showError(`Failed to update discovery: ${err.message}`, 'Update Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: discoveriesKeys.all() });
    },
  });

  return {
    discoveries: discoveriesQuery.data ?? [],
    stats: statsQuery.data,
    isLoading: discoveriesQuery.isLoading,
    isError: discoveriesQuery.isError,
    error: discoveriesQuery.error,
    refetch: discoveriesQuery.refetch,

    updateDiscovery: updateDiscoveryMutation.mutate,
    updateDiscoveryAsync: updateDiscoveryMutation.mutateAsync,
    isUpdating: updateDiscoveryMutation.isPending,
  };
}

export function useInfiniteDiscoveries(filters?: DiscoveryFilters) {
  const discoveriesQuery = useInfiniteQuery({
    queryKey: [...discoveriesKeys.list(filters ?? {}), 'infinite'],
    queryFn: ({ pageParam = 0 }) => api.listDiscoveries({
      ...filters,
      limit: PAGE_SIZE,
      offset: pageParam,
    }),
    getNextPageParam: (lastPage) => {
      const pagination = lastPage.pagination;
      return pagination.offset + pagination.limit < pagination.total
        ? pagination.offset + pagination.limit
        : undefined;
    },
    initialPageParam: 0,
  });

  return {
    discoveries: discoveriesQuery.data?.pages.flatMap((page) => page.discoveries) ?? [],
    hasNextPage: discoveriesQuery.hasNextPage,
    isFetchingNextPage: discoveriesQuery.isFetchingNextPage,
    isLoading: discoveriesQuery.isLoading,
    refetch: discoveriesQuery.refetch,
    fetchNextPage: discoveriesQuery.fetchNextPage,
  };
}

export function useDiscovery(discoveryId: string | null) {
  return useQuery({
    queryKey: discoveriesKeys.detail(discoveryId ?? ''),
    queryFn: async () => {
      if (!discoveryId) throw new Error('Discovery ID required');
      const response = await api.getDiscovery(discoveryId);
      return response.discovery;
    },
    enabled: !!discoveryId,
    retry: false,
  });
}
