import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, LoaderCircle, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ReactElement } from "react";

function countSubjects(subjects: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of subjects) {
    const subject = value.trim() || "Untitled message";
    counts.set(subject, (counts.get(subject) ?? 0) + 1);
  }
  return [...counts];
}

export function InboxCatchupPanel({ onClose, onApplied }: { onClose: () => void; onApplied: () => Promise<void> }): ReactElement {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originalsOpen, setOriginalsOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [retainedOpen, setRetainedOpen] = useState(false);
  const queryKey = ["inbox-catchup"];
  const query = useQuery({ queryKey, queryFn: () => api.getInboxCatchup(), retry: false, staleTime: 0,
    refetchInterval: query => ["analyzing", "applying"].includes(query.state.data?.job?.status ?? "") ? 1500 : false });
  const job = query.data?.job;
  const subjects = new Map((job?.sourceSubjects ?? job?.archiveSubjects)?.map(source => [source.sourceId, source.subject]));
  const archiveCount = job?.plan?.archiveSourceIds?.length ?? 0;
  const retained = job?.plan?.retainedSources ?? [];
  const safeReview = job?.plan?.applyPolicyVersion === 2;
  const running = busy || job?.status === "analyzing" || job?.status === "applying";
  const mutate = async (apply: boolean) => {
    if (running) return;
    setBusy(true); setError(null);
    if (!apply) { setOriginalsOpen(false); setThreadsOpen(false); setRetainedOpen(false); }
    try {
      const result = apply && job ? await api.applyInboxCatchup(job.id) : await api.startInboxCatchup();
      queryClient.setQueryData(queryKey, result);
      if (apply) await onApplied();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Catch-up failed. Your original messages are preserved.");
      await query.refetch();
    } finally { setBusy(false); }
  };
  const button = "inline-flex min-h-8 items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60";
  return <section aria-label="Catch me up" className="border-b border-border bg-surface p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="max-w-prose">
        <h2 className="flex items-center gap-2 text-base font-semibold"><Sparkles className="h-4 w-4 text-accent" />Catch me up</h2>
        <p className="mt-1 text-sm text-muted-foreground">Focused operator actions, checked against current system state. Uncertain originals stay in your inbox.</p>
        {!job && <p className="mt-2 text-xs text-muted-foreground">Brain proposes threads; JEV checks complete messages. Review before archiving. Tasks, bugs, and file claims stay unchanged.</p>}
      </div>
      <button type="button" onClick={onClose} aria-label="Close catch-up review" className={`${button} shrink-0 hover:bg-surface-secondary`}><X className="h-4 w-4" /></button>
    </div>
    {(error || query.error || job?.error) && <p role="alert" className="mt-3 text-sm text-danger">{error ?? query.error?.message ?? job?.error}</p>}
    {query.isPending && <p role="status" className="mt-3 text-sm">Checking for an existing review…</p>}
    {running && <p role="status" aria-live="polite" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <LoaderCircle className="h-4 w-4 animate-spin" />{busy ? "Updating catch-up…" : job?.detail}
      <span className="text-muted-foreground">You can close this panel; the review continues.</span>
    </p>}
    {job?.status === "review" && job.plan && <div className="mt-3">
      <p aria-label="Catch-up statistics" className="text-sm font-medium">{job.unreadCount} unread reviewed · {job.plan.actions.length} new action {job.plan.actions.length === 1 ? "thread" : "threads"} · {archiveCount} to archive · {retained.length} kept in inbox</p>
      {!safeReview && <p className="mt-2 text-sm">This older review lacks safe archive decisions. Start a fresh review before applying.</p>}
      {!job.unreadCount && <p className="mt-2 text-sm">You’re already caught up.</p>}
      {job.unreadCount > 0 && <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={running || !safeReview || (archiveCount === 0 && job.plan.actions.length === 0)} onClick={() => void mutate(true)} className={`${button} bg-accent text-accent-foreground hover:opacity-90`}>
          <Archive className="h-4 w-4" />Apply catch-up</button>
        <button type="button" disabled={running} onClick={() => void mutate(false)} className={`${button} hover:bg-surface-secondary`}>Start a fresh review</button>
        <p className="basis-full text-xs text-muted-foreground">{archiveCount} confidently classified originals will be archived, never deleted. {retained.length} originals and any new arrivals stay untouched.</p>
      </div>}
      {job.unreadCount > 0 && <div className="mt-2 max-w-prose divide-y divide-border text-sm">
        <details open={originalsOpen} onToggle={event => setOriginalsOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-accent">Originals to archive ({archiveCount})</summary>
          {originalsOpen && <ul className="max-h-48 space-y-1 overflow-y-auto pb-3 pr-2">
            {countSubjects((job.archiveSubjects ?? []).map(source => source.subject)).map(([subject, count]) => <li key={subject} className="break-words">{subject}{count > 1 && <span className="ml-2 text-muted-foreground">({count} messages)</span>}</li>)}
            {!archiveCount && <li className="text-muted-foreground">No originals will be archived.</li>}
          </ul>}
        </details>
        {retained.length > 0 && <details open={retainedOpen} onToggle={event => setRetainedOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-accent">Originals kept in inbox ({retained.length})</summary>
          {retainedOpen && <ul className="max-h-48 space-y-3 overflow-y-auto pb-3 pr-2">
            {retained.map(source => <li key={source.sourceId} className="break-words">
              <p>{subjects.get(source.sourceId) ?? "Original message"}</p>
              <p className="mt-1 text-xs text-muted-foreground">{source.reason}</p>
            </li>)}
          </ul>}
        </details>}
        <details open={threadsOpen} onToggle={event => setThreadsOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-accent">New action threads ({job.plan.actions.length})</summary>
          {threadsOpen && <ul className="max-h-48 space-y-3 overflow-y-auto pb-3 pr-2">
            {job.plan.actions.map((action, index) => <li key={index} className="break-words">
              <p className="font-medium">Action needed: {action.title}</p>
              <ul className="mt-1 space-y-1 pl-3 text-xs text-muted-foreground">
                {countSubjects(action.sourceIds.flatMap(id => subjects.has(id) ? [subjects.get(id)!] : [])).map(([subject, count]) =>
                  <li key={subject}>{subject}{count > 1 ? ` (${count} originals)` : ""}</li>)}
              </ul>
            </li>)}
          </ul>}
        </details>
      </div>}
    </div>}
    {job?.status === "completed" && !running && <p role="status" className="mt-4 text-sm">Applied: {job.archivedCount ?? 0} original messages archived; {job.plan?.actions.length ?? 0} focused action {job.plan?.actions.length === 1 ? "message" : "messages"} created. {retained.length} originals kept untouched in your inbox.</p>}
    {!running && !query.isPending && job?.status !== "recovery_required" && (job?.status !== "review" || !job.unreadCount) && <button type="button" onClick={() => void mutate(false)}
      className={`${button} mt-4 border border-border hover:bg-surface-secondary`}><Sparkles className="h-4 w-4" />{job ? "Start a fresh review" : "Review unread messages"}</button>}
  </section>;
}
