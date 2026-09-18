import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';

/** Keep the mounted workspace and unsaved inputs intact during a rollout. */
export function WorkspaceConnectionNotice() {
  const { connected, authenticated, connect } = useWebSocket({ channels: [] });
  const [elapsed, setElapsed] = useState(0);
  const ready = connected && authenticated;
  useEffect(() => {
    setElapsed(0);
    if (ready) return;
    const began = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - began) / 1000)), 1000);
    return () => { clearInterval(timer); };
  }, [ready]);
  if (ready || elapsed < 5) return null;
  return <aside role="status" aria-live="polite" className="fixed bottom-12 left-1/2 z-[1000] flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-surface p-4 text-sm text-foreground shadow-lg">
    <LoaderCircle aria-hidden="true" className="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none text-accent" />
    <div><p className="font-semibold">{elapsed >= 180 ? 'Workspace connection is taking longer than expected' : 'Reconnecting to your workspace'}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{elapsed >= 180
        ? 'Check your connection or try reconnecting. Keep this tab open to preserve unsaved edits.'
        : 'It may be restarting or updating. We’ll reconnect automatically; keep this tab open.'}</p>
      {elapsed >= 180 && <button onClick={connect} className="mt-2 rounded px-2 py-1 font-medium text-accent focus-visible:outline-2">Reconnect</button>}
    </div>
  </aside>;
}
