import { useEffect, useState } from 'react';
import { startSessionHeartbeat } from '@/lib/session-heartbeat';

export function HostedSessionNotice() {
  const [expired, setExpired] = useState(false);
  useEffect(() => startSessionHeartbeat((authenticated) => setExpired(!authenticated)), []);
  if (!expired) return null;
  const reefHost = window.location.hostname.split('.').slice(1).join('.');
  return <aside role="alert" className="fixed top-4 left-1/2 z-[1100] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-xl border border-border bg-surface p-4 text-sm text-foreground shadow-lg">
    Your Reef session has expired. Keep this tab open to preserve unsaved edits.{' '}
    <a className="font-semibold underline" href={`https://${reefHost}/auth/login`} target="_blank" rel="noopener noreferrer">Sign in to Reef</a>
  </aside>;
}
