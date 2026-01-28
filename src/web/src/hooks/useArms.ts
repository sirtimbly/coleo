/**
 * Arms Hook - React Query Integration
 * 
 * Provides queries and mutations for arm management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Arm } from '@/lib/api';
import { armsKeys } from '@/lib/queryKeys';
import { useToast } from '@/hooks/useToast';

// Types
interface CreateArmVariables {
  name: string;
  domain: string;
  harness: string;
  contextBudget?: number;
  config?: Record<string, unknown>;
}

interface UpdateArmVariables {
  id: string;
  updates: Partial<Arm>;
}

export function useArms() {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const armsQuery = useQuery({
    queryKey: armsKeys.list(),
    queryFn: async () => {
      const response = await api.listArms();
      return response.arms;
    },
  });

  const createArmMutation = useMutation({
    mutationFn: async (data: CreateArmVariables) => {
      const response = await api.createArm(data);
      return response.arm;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: armsKeys.all() });
    },
    onError: (err) => {
      showError(`Failed to create arm: ${err.message}`, 'Create Failed');
    },
  });

  const updateArmMutation = useMutation({
    mutationFn: async ({ id, updates }: UpdateArmVariables) => {
      const response = await api.updateArm(id, updates);
      return response.arm;
    },
    onMutate: async ({ id, updates }) => {
      await queryClient.cancelQueries({ queryKey: armsKeys.all() });
      const previousArms = queryClient.getQueryData(armsKeys.list());

      queryClient.setQueryData(
        armsKeys.list(),
        (old: Arm[] | undefined) => {
          if (!old) return old;
          return old.map((arm) => (arm.id === id ? { ...arm, ...updates } : arm));
        }
      );

      return { previousArms };
    },
    onError: (err, _variables, context) => {
      if (context?.previousArms) {
        queryClient.setQueryData(armsKeys.list(), context.previousArms);
      }
      showError(`Failed to update arm: ${err.message}`, 'Update Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: armsKeys.all() });
    },
  });

  const deleteArmMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.deleteArm(id);
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: armsKeys.all() });
      const previousArms = queryClient.getQueryData(armsKeys.list());

      queryClient.setQueryData(
        armsKeys.list(),
        (old: Arm[] | undefined) => {
          if (!old) return old;
          return old.filter((arm) => arm.id !== id);
        }
      );

      return { previousArms };
    },
    onError: (err, _id, context) => {
      if (context?.previousArms) {
        queryClient.setQueryData(armsKeys.list(), context.previousArms);
      }
      showError(`Failed to delete arm: ${err.message}`, 'Delete Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: armsKeys.all() });
    },
  });

  return {
    arms: armsQuery.data ?? [],
    isLoading: armsQuery.isLoading,
    isError: armsQuery.isError,
    error: armsQuery.error,
    refetch: armsQuery.refetch,

    createArm: createArmMutation.mutate,
    createArmAsync: createArmMutation.mutateAsync,
    isCreating: createArmMutation.isPending,

    updateArm: updateArmMutation.mutate,
    updateArmAsync: updateArmMutation.mutateAsync,
    isUpdating: updateArmMutation.isPending,

    deleteArm: deleteArmMutation.mutate,
    deleteArmAsync: deleteArmMutation.mutateAsync,
    isDeleting: deleteArmMutation.isPending,
  };
}

export function useArm(armId: string | null) {
  return useQuery({
    queryKey: armsKeys.detail(armId ?? ''),
    queryFn: async () => {
      if (!armId) throw new Error('Arm ID required');
      const response = await api.getArm(armId);
      return response.arm;
    },
    enabled: !!armId,
    retry: false,
  });
}

export function useArmMessages(armId: string | null, limit = 50) {
  return useQuery({
    queryKey: armsKeys.messages(armId ?? ''),
    queryFn: async () => {
      if (!armId) throw new Error('Arm ID required');
      const response = await api.getArmMessages(armId, limit);
      return response.messages;
    },
    enabled: !!armId,
    retry: false,
  });
}

export function useArmTodos(armId: string | null) {
  return useQuery({
    queryKey: armsKeys.todos(armId ?? ''),
    queryFn: async () => {
      if (!armId) throw new Error('Arm ID required');
      const response = await api.getArmTodos(armId);
      return response.todos;
    },
    enabled: !!armId,
    retry: false,
  });
}
