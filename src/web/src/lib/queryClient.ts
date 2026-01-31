/**
 * Query Client Configuration with Persistence
 * 
 * Features:
 * - 30s stale time for most queries
 * - localStorage persistence for offline support
 * - No retries (fail fast)
 * - React Query Devtools enabled on localhost
 */

import { QueryClient } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';

const STALE_TIME = 30 * 1000; // 30 seconds

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_TIME,
      retry: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
    },
    mutations: {
      retry: false,
    },
  },
});

// Create localStorage persister for query cache
export const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'coleo-query-cache',
});

// Check if running on localhost
export const isLocalhost = 
  typeof window !== 'undefined' && 
  (window.location.hostname === 'localhost' || 
   window.location.hostname === '127.0.0.1');
