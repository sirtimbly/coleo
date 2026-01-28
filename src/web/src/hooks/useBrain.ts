/**
 * Brain Hook - React Query Integration
 * 
 * Provides queries and mutations for brain management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { brainKeys } from '@/lib/queryKeys';
import { useToast } from '@/hooks/useToast';

// Types
interface SendMessageVariables {
  message: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  domain?: string;
}

export function useBrain() {
  const queryClient = useQueryClient();
  const { showError, showSuccess } = useToast();

  const statusQuery = useQuery({
    queryKey: brainKeys.status(),
    queryFn: async () => {
      const response = await api.getBrainStatus();
      return response.brain;
    },
  });

  const configQuery = useQuery({
    queryKey: brainKeys.config(),
    queryFn: async () => {
      const response = await api.getBrainConfig();
      return response.brain;
    },
  });

  const startBrainMutation = useMutation({
    mutationFn: async () => {
      const response = await api.startBrain();
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: brainKeys.all() });
      showSuccess('Brain started successfully');
    },
    onError: (err) => {
      showError(`Failed to start brain: ${err.message}`, 'Start Failed');
    },
  });

  const stopBrainMutation = useMutation({
    mutationFn: async () => {
      const response = await api.stopBrain();
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: brainKeys.all() });
      showSuccess('Brain stopped successfully');
    },
    onError: (err) => {
      showError(`Failed to stop brain: ${err.message}`, 'Stop Failed');
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async (data: SendMessageVariables) => {
      const response = await api.sendBrainMessage(data);
      return response;
    },
    onSuccess: () => {
      showSuccess('Message sent to brain');
    },
    onError: (err) => {
      showError(`Failed to send message: ${err.message}`, 'Send Failed');
    },
  });

  return {
    status: statusQuery.data,
    config: configQuery.data,
    isLoading: statusQuery.isLoading || configQuery.isLoading,
    isError: statusQuery.isError || configQuery.isError,
    error: statusQuery.error || configQuery.error,
    refetch: () => {
      statusQuery.refetch();
      configQuery.refetch();
    },

    startBrain: startBrainMutation.mutate,
    startBrainAsync: startBrainMutation.mutateAsync,
    isStarting: startBrainMutation.isPending,

    stopBrain: stopBrainMutation.mutate,
    stopBrainAsync: stopBrainMutation.mutateAsync,
    isStopping: stopBrainMutation.isPending,

    sendMessage: sendMessageMutation.mutate,
    sendMessageAsync: sendMessageMutation.mutateAsync,
    isSending: sendMessageMutation.isPending,
  };
}
