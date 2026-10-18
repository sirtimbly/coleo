/**
 * Mail Hook - React Query Integration
 * 
 * Provides queries and mutations for mail management.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type MailMessage } from '@/lib/api';
import { mailKeys } from '@/lib/queryKeys';
import { useToast } from '@/hooks/useToast';

// Types
interface SendMailVariables {
  from: string;
  to: string;
  subject: string;
  body: string;
  headers?: Record<string, string>;
}

export function useMail() {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const inboxQuery = useQuery({
    queryKey: mailKeys.inbox(),
    queryFn: async () => {
      const response = await api.listInbox();
      return response;
    },
  });

  const sentQuery = useQuery({
    queryKey: mailKeys.sent(),
    queryFn: async () => {
      const response = await api.listSent();
      return response;
    },
  });

  const archiveQuery = useQuery({
    queryKey: mailKeys.archive(),
    queryFn: async () => {
      const response = await api.listArchive();
      return response;
    },
  });

  const sendMailMutation = useMutation({
    mutationFn: async (data: SendMailVariables) => {
      const response = await api.sendMail(data);
      return response.message;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mailKeys.all() });
    },
    onError: (err) => {
      showError(`Failed to send mail: ${err.message}`, 'Send Failed');
    },
  });

  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.markMailRead(id);
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: mailKeys.all() });
      const previousInbox = queryClient.getQueryData(mailKeys.inbox());

      queryClient.setQueryData(
        mailKeys.inbox(),
        (old: { messages: MailMessage[]; pagination: { unread: number } } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            messages: old.messages.map((msg) =>
              msg.id === id ? { ...msg, flags: { ...msg.flags, seen: true } } : msg
            ),
            pagination: {
              ...old.pagination,
              unread: Math.max(0, old.pagination.unread - 1),
            },
          };
        }
      );

      return { previousInbox };
    },
    onError: (err, _id, context) => {
      if (context?.previousInbox) {
        queryClient.setQueryData(mailKeys.inbox(), context.previousInbox);
      }
      showError(`Failed to mark mail as read: ${err.message}`, 'Update Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: mailKeys.all() });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.archiveMail(id);
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: mailKeys.all() });
      const previousInbox = queryClient.getQueryData(mailKeys.inbox());

      queryClient.setQueryData(
        mailKeys.inbox(),
        (old: { messages: MailMessage[]; pagination: { total: number; unread: number } } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            messages: old.messages.filter((msg) => msg.id !== id),
            pagination: {
              ...old.pagination,
              total: old.pagination.total - 1,
              unread: old.messages.find((m) => m.id === id)?.flags.seen
                ? old.pagination.unread
                : Math.max(0, old.pagination.unread - 1),
            },
          };
        }
      );

      return { previousInbox };
    },
    onError: (err, _id, context) => {
      if (context?.previousInbox) {
        queryClient.setQueryData(mailKeys.inbox(), context.previousInbox);
      }
      showError(`Failed to archive mail: ${err.message}`, 'Archive Failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: mailKeys.all() });
    },
  });

  return {
    inbox: inboxQuery.data?.messages ?? [],
    inboxPagination: inboxQuery.data?.pagination,
    sent: sentQuery.data?.messages ?? [],
    sentPagination: sentQuery.data?.pagination,
    archive: archiveQuery.data?.messages ?? [],
    archivePagination: archiveQuery.data?.pagination,

    isLoadingInbox: inboxQuery.isLoading,
    isLoadingSent: sentQuery.isLoading,
    isLoadingArchive: archiveQuery.isLoading,

    refetchInbox: inboxQuery.refetch,
    refetchSent: sentQuery.refetch,
    refetchArchive: archiveQuery.refetch,

    sendMail: sendMailMutation.mutate,
    sendMailAsync: sendMailMutation.mutateAsync,
    isSending: sendMailMutation.isPending,

    markRead: markReadMutation.mutate,
    isMarkingRead: markReadMutation.isPending,

    archiveMail: archiveMutation.mutate,
    isArchiving: archiveMutation.isPending,
  };
}
