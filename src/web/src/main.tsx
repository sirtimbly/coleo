import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Toast } from '@heroui/react'
import './index.css'
import App from './App.tsx'
import { queryClient, persister, isLocalhost } from '@/lib/queryClient'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider 
      client={queryClient} 
      persistOptions={{
        persister,
        buster: '2026-07-query-cache-v2',
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => query.queryKey[0] !== 'tasks',
        },
      }}
    >
      <App />
      <Toast.Container placement="bottom end" />
      {isLocalhost && <ReactQueryDevtools initialIsOpen={false} />}
    </PersistQueryClientProvider>
  </StrictMode>,
)
