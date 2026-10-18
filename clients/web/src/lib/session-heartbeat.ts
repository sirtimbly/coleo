/** HTTP activity checks keep hosted sessions fresh even with a long-lived WebSocket. */
let lastActivity = Date.now();
const ACTIVE_WINDOW_MS = 15 * 60_000;

export function isSessionActive(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && Date.now() - lastActivity < ACTIVE_WINDOW_MS;
}

export function startSessionHeartbeat(onSession: (authenticated: boolean) => void): () => void {
  lastActivity = Date.now();
  let lastCheck = -Infinity;
  let stopped = false;
  let pending = false;
  const controller = new AbortController();
  const check = async () => {
    const now = Date.now();
    if (stopped || pending || !isSessionActive() || now - lastCheck < 60_000) return;
    pending = true;
    lastCheck = now;
    try {
      const response = await fetch('/.reef/session', {
        credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (stopped) return;
      // Standalone Coleo and older Reef deployments do not expose this endpoint.
      if (response.headers.get('x-reef-session') !== '1') { stop(); return; }
      if (response.status === 401 || response.status === 403) onSession(false);
      else if (response.ok) onSession(true);
    } catch { /* Network interruptions retry on the next active check. */ }
    finally { pending = false; }
  };
  const activity = () => { lastActivity = Date.now(); void check(); };
  const visible = () => { if (document.visibilityState === 'visible') activity(); };
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  const timer = setInterval(() => { void check(); }, 30_000);
  function stop() {
    stopped = true;
    controller.abort();
    clearInterval(timer);
    for (const event of events) window.removeEventListener(event, activity, true);
    document.removeEventListener('visibilitychange', visible);
  }
  for (const event of events) window.addEventListener(event, activity, { passive: true, capture: true });
  document.addEventListener('visibilitychange', visible);
  void check();
  return stop;
}
