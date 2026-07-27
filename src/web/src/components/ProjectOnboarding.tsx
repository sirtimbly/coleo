import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, Clipboard, FolderGit2, GitBranch, KeyRound, LoaderCircle, RefreshCw } from 'lucide-react';

import { api } from '@/lib/api';

import type { FormEvent, ReactNode } from 'react';
import type { OnboardingStatus } from '@/lib/api';

interface ProjectOnboardingProps {
  status: OnboardingStatus;
  onStatusChange: (status: OnboardingStatus) => void;
}

interface ProjectOnboardingGateProps {
  children: ReactNode;
}

const MAX_LISTED_ENTRIES = 15;

function CloneSummary({ status, onContinue }: { status: OnboardingStatus; onContinue: () => void }) {
  const { repository } = status;
  const listedEntries = repository.topLevelEntries.slice(0, MAX_LISTED_ENTRIES);
  const hiddenEntryCount = repository.topLevelEntries.length - listedEntries.length;

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 lg:py-12">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8">
          <div className="mb-3 inline-flex rounded-full border border-success/25 bg-success/10 px-3 py-1 text-xs font-semibold text-success">
            Clone complete
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Repository verified</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            The repository was cloned into <code className="text-foreground">{status.projectDir}</code>.
            Review the checkout below to confirm everything you expected was downloaded.
          </p>
        </div>

        <section className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <dl className="space-y-3 text-sm">
            <div className="flex items-start justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">Remote</dt>
              <dd className="min-w-0 break-all text-right font-mono text-xs leading-5">{repository.remoteUrl ?? 'Unknown'}</dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">Branch</dt>
              <dd className="inline-flex items-center gap-1.5 font-medium">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                {repository.branch ?? 'Detached HEAD'}
              </dd>
            </div>
            {repository.commit ? (
              <div className="flex items-start justify-between gap-4">
                <dt className="shrink-0 text-muted-foreground">Latest commit</dt>
                <dd className="min-w-0 text-right">
                  <span className="font-mono text-xs">{repository.commit.shortHash}</span>{' '}
                  <span className="font-medium">{repository.commit.subject}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {repository.commit.author} · {new Date(repository.commit.date).toLocaleString()}
                  </span>
                </dd>
              </div>
            ) : null}
            <div className="flex items-start justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">Tracked files</dt>
              <dd className="font-medium">
                {repository.trackedFileCount ?? 'Unknown'}
                {repository.dirtyFileCount ? (
                  <span className="ml-2 text-xs font-normal text-warning">
                    {repository.dirtyFileCount} uncommitted
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>

          {repository.topLevelEntries.length > 0 ? (
            <div className="mt-5 rounded-lg border border-border bg-surface-secondary p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <FolderGit2 className="h-3.5 w-3.5" />
                Top-level contents ({repository.topLevelEntries.length})
              </div>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs leading-5 sm:grid-cols-3">
                {listedEntries.map((entry) => (
                  <li key={entry} className="truncate">{entry}</li>
                ))}
              </ul>
              {hiddenEntryCount > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">…and {hiddenEntryCount} more</p>
              ) : null}
            </div>
          ) : (
            <div className="mt-5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
              The checkout appears to be empty. Verify the repository URL and branch, then clone again.
            </div>
          )}

          <button
            type="button"
            onClick={onContinue}
            className="mt-5 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition hover:opacity-90"
          >
            Continue to Coleo
            <ArrowRight className="h-4 w-4" />
          </button>
        </section>
      </div>
    </main>
  );
}

function ProjectOnboarding({ status, onStatusChange }: ProjectOnboardingProps) {
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [isGeneratingKey, setIsGeneratingKey] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clonedStatus, setClonedStatus] = useState<OnboardingStatus | null>(null);

  const generateKey = async () => {
    setIsGeneratingKey(true);
    setError(null);
    try {
      onStatusChange(await api.generateOnboardingSshKey());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate SSH key');
    } finally {
      setIsGeneratingKey(false);
    }
  };

  const copyPublicKey = async () => {
    if (!status.ssh.publicKey) return;
    try {
      await navigator.clipboard.writeText(status.ssh.publicKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Unable to copy the public key. Select and copy it manually.');
    }
  };

  const cloneRepository = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsCloning(true);
    setError(null);
    try {
      setClonedStatus(await api.cloneOnboardingRepository({
        repositoryUrl: repositoryUrl.trim(),
        branch: branch.trim() || undefined,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clone repository');
    } finally {
      setIsCloning(false);
    }
  };

  if (clonedStatus) {
    return (
      <CloneSummary status={clonedStatus} onContinue={() => onStatusChange(clonedStatus)} />
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 lg:py-12">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8">
          <div className="mb-3 inline-flex rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
            Project setup
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Connect your Git repository</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Coleo needs a project checkout before its arms can work. Generate an SSH key, add the public key to
            your Git provider, then clone the repository into the workspace.
          </p>
        </div>

        <div className="space-y-4">
          <section className="rounded-xl border border-border bg-surface p-5 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-sm font-semibold">
                {status.ssh.configured ? <Check className="h-4 w-4 text-success" /> : '1'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">Create an SSH key</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      The private key stays on this Coleo host. Only the public key is shown here.
                    </p>
                  </div>
                  {!status.ssh.configured ? (
                    <button
                      type="button"
                      onClick={generateKey}
                      disabled={isGeneratingKey}
                      className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isGeneratingKey ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <KeyRound className="h-4 w-4" />
                      )}
                      {isGeneratingKey ? 'Generating…' : 'Generate key'}
                    </button>
                  ) : null}
                </div>

                {status.ssh.publicKey ? (
                  <div className="mt-4 rounded-lg border border-border bg-surface-secondary p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Public key
                      </span>
                      <button
                        type="button"
                        onClick={copyPublicKey}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
                      >
                        {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <code className="block break-all text-xs leading-5 text-foreground">
                      {status.ssh.publicKey}
                    </code>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-surface p-5 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-sm font-semibold">
                2
              </div>
              <div>
                <h2 className="font-semibold">Authorize the key with your Git provider</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Add the public key as an SSH key for your account or as a repository deploy key. Give it write
                  access if Coleo should push branches or commits.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-surface p-5 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-sm font-semibold">
                3
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">Clone the project</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  The checkout will be created at <code className="text-foreground">{status.projectDir}</code>.
                </p>

                <form className="mt-4 space-y-4" onSubmit={cloneRepository}>
                  <div>
                    <label htmlFor="onboarding-repository-url" className="mb-1.5 block text-sm font-medium">
                      Repository URL
                    </label>
                    <input
                      id="onboarding-repository-url"
                      type="text"
                      value={repositoryUrl}
                      onChange={(event) => setRepositoryUrl(event.target.value)}
                      placeholder="git@github.com:your-org/your-project.git"
                      disabled={!status.ssh.configured || isCloning}
                      className="w-full rounded-md border border-border bg-surface-secondary px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="onboarding-branch" className="mb-1.5 block text-sm font-medium">
                      Branch, tag, or commit <span className="font-normal text-muted-foreground">(optional)</span>
                    </label>
                    <input
                      id="onboarding-branch"
                      type="text"
                      value={branch}
                      onChange={(event) => setBranch(event.target.value)}
                      placeholder="main"
                      disabled={!status.ssh.configured || isCloning}
                      className="w-full rounded-md border border-border bg-surface-secondary px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={!status.ssh.configured || !repositoryUrl.trim() || isCloning}
                    className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isCloning ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <GitBranch className="h-4 w-4" />
                    )}
                    {isCloning ? 'Cloning repository…' : 'Clone and continue'}
                  </button>
                </form>
              </div>
            </div>
          </section>
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </main>
  );
}

export function ProjectOnboardingGate({ children }: ProjectOnboardingGateProps) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState(() => api.getApiKey() || '');

  const loadStatus = useCallback(async () => {
    setError(null);
    try {
      setStatus(await api.getOnboardingStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check project setup');
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  if (error) {
    const needsApiKey = error.includes('X-API-Key') || error.includes('API key');
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="max-w-md rounded-xl border border-danger/30 bg-surface p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold">Unable to check project setup</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          {needsApiKey ? (
            <div className="mt-4 text-left">
              <label htmlFor="onboarding-api-key" className="mb-1.5 block text-sm font-medium">
                Coleo API key
              </label>
              <input
                id="onboarding-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="w-full rounded-md border border-border bg-surface-secondary px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => {
              if (needsApiKey && apiKey.trim()) {
                api.setApiKey(apiKey.trim());
              }
              void loadStatus();
            }}
            disabled={needsApiKey && !apiKey.trim()}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Checking project setup…
        </div>
      </main>
    );
  }

  if (!status.ready) {
    return <ProjectOnboarding status={status} onStatusChange={setStatus} />;
  }

  return children;
}
