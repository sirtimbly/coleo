import { useState } from 'react';
import { Folder, FolderGit2, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import type { OnboardingStatus } from '@/lib/api';

interface WorkspaceRepositoriesProps {
  status?: OnboardingStatus;
  onStatusChange?: (status: OnboardingStatus) => void;
  onboarding?: boolean;
}

export function WorkspaceRepositories({ status: initial, onStatusChange, onboarding = false }: WorkspaceRepositoriesProps) {
  const [current, setCurrent] = useState<OnboardingStatus | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = current ?? initial;
  const update = async (accept: boolean) => {
    setBusy(true);
    setError('');
    try {
      const result = await (accept ? api.acceptOnboardingWorkspace() : api.getOnboardingStatus());
      setCurrent(result);
      if (accept) onStatusChange?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to inspect the workspace');
    } finally { setBusy(false); }
  };
  return (
    <section className="rounded-xl border border-border bg-surface p-5" aria-labelledby="workspace-repositories-heading">
      <h2 id="workspace-repositories-heading" className="flex items-center gap-2 font-semibold">
        <FolderGit2 className="h-5 w-5 text-accent" aria-hidden="true" />
        {onboarding ? 'Use this workspace' : 'Workspace repositories'}
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Work with one repository, several repositories in subfolders, or an empty workspace.
        No root Git repository or new SSH key is required.
      </p>
      {status ? <code className="mt-3 block break-all text-xs text-muted-foreground">{status.projectDir}</code> : null}
      {status?.workspace?.directories ? (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium">Directories in this workspace <span className="text-muted-foreground">({status.workspace.directoryCount ?? status.workspace.directories.length})</span></h3>
          <div role="region" aria-label="Workspace directories" tabIndex={0}
            className="max-h-48 overflow-y-auto overscroll-contain rounded-md border border-border bg-surface-secondary px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            {status.workspace.directories.length ? (
              <ul className="divide-y divide-border">
                {status.workspace.directories.map(directory => (
                  <li key={directory} className="flex items-start gap-2 py-2 text-xs">
                    <Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 break-all font-mono">{directory}/</span>
                    {status.workspace?.repositories.includes(directory) ? <span className="ml-auto shrink-0 text-accent">Git repo</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="py-3 text-sm text-muted-foreground">No directories yet.</p>}
          </div>
          {(status.workspace.directoryCount ?? 0) > status.workspace.directories.length ? (
            <p className="mt-1 text-xs text-muted-foreground">Showing the first {status.workspace.directories.length} directories.</p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-4 text-sm" aria-live="polite">
        {status?.workspace?.repositories.length ? (
          <div>
          <h3 className="mb-2 font-medium">Detected repositories ({status.workspace.repositories.length})</h3>
          <ul aria-label="Detected repositories" tabIndex={0} className="max-h-48 divide-y divide-border overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            {status.workspace.repositories.map(path => <li key={path} className="break-all py-2 font-mono text-xs">{path === '.' ? 'Workspace root' : path}</li>)}
          </ul>
          </div>
        ) : <p className="text-muted-foreground">{status ? 'No repositories found yet. You can add them later.' : 'Scan the workspace to find its repositories.'}</p>}
        {status?.workspace?.scanLimited ? <p className="mt-2 text-warning">Scan limited to four folder levels and 1,000 directories; some folders were skipped or inaccessible.</p> : null}
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Clone or move repositories into workspace subfolders whenever you need them, then scan again here in Settings → Workspace repositories.
        Dependency folders, hidden folders, and symbolic links are skipped.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {onboarding ? <button type="button" disabled={busy} onClick={() => void update(true)}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {busy ? 'Checking workspace…' : 'Continue with this workspace'}
        </button> : null}
        <button type="button" disabled={busy} onClick={() => void update(false)}
          className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
          {busy ? 'Scanning…' : 'Scan for repositories'}
        </button>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
    </section>
  );
}
