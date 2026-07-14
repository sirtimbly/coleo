import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, FilePlus2, LoaderCircle, RefreshCw, Save, Sparkles } from 'lucide-react';

import { usePageTitle } from '@/hooks/usePageTitle';
import { api, type ProjectPlanCandidate, type ProjectSetupStatus } from '@/lib';
import { markProjectSetupOpened } from '@/lib/project-setup-visit';
import { useWorkspaceOpenRoute } from '@/workspace/route-context';

interface EditorState {
  path: string;
  content: string;
  expectedHash: string | null;
  savedContent: string;
}

function editorFromStatus(status: ProjectSetupStatus): EditorState {
  const selected = status.canonicalPlan
    ?? status.candidates.find((candidate) => candidate.path === status.recommendedPath)
    ?? status.candidates[0];
  if (selected) {
    return {
      path: selected.path,
      content: selected.content,
      expectedHash: selected.contentHash,
      savedContent: selected.content,
    };
  }
  return {
    path: '.project/plan.md',
    content: status.defaultContent,
    expectedHash: null,
    savedContent: '',
  };
}

function editorFromCandidate(candidate: ProjectPlanCandidate): EditorState {
  return {
    path: candidate.path,
    content: candidate.content,
    expectedHash: candidate.contentHash,
    savedContent: candidate.content,
  };
}

export function SetupPage() {
  usePageTitle('Coleo Observatory - Project Setup');
  const openWorkspaceRoute = useWorkspaceOpenRoute();
  const [status, setStatus] = useState<ProjectSetupStatus | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ mode: 'ai' | 'structured'; taskCount: number; createdTaskCount: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await api.getProjectSetupStatus();
      setStatus(nextStatus);
      setEditor(editorFromStatus(nextStatus));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect project plans');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    markProjectSetupOpened();
    void load();
  }, [load]);

  const dirty = useMemo(() => editor ? editor.content !== editor.savedContent : false, [editor]);

  const selectCandidate = (candidate: ProjectPlanCandidate) => {
    if (dirty && !window.confirm('Discard your unsaved edits and open another file?')) return;
    setEditor(editorFromCandidate(candidate));
    setResult(null);
    setError(null);
  };

  const createPlan = () => {
    if (!status) return;
    if (dirty && !window.confirm('Discard your unsaved edits and start a new plan?')) return;
    setEditor({
      path: '.project/plan.md',
      content: status.defaultContent,
      expectedHash: status.canonicalPlan?.contentHash ?? null,
      savedContent: status.canonicalPlan?.content ?? '',
    });
    setResult(null);
    setError(null);
  };

  const save = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.saveProjectPlanFile({
        path: editor.path,
        content: editor.content,
        expectedHash: editor.expectedHash,
      });
      setEditor((current) => current ? {
        ...current,
        expectedHash: response.file.contentHash,
        savedContent: response.file.content,
      } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the plan');
    } finally {
      setSaving(false);
    }
  };

  const prepare = async () => {
    if (!editor) return;
    setPreparing(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.prepareProjectPlan({
        sourcePath: editor.path,
        content: editor.content,
        expectedHash: editor.expectedHash,
      });
      setResult({
        mode: response.mode,
        taskCount: response.taskCount,
        createdTaskCount: response.createdTaskCount,
      });
      setEditor({
        path: response.canonicalPlan.path,
        content: response.canonicalPlan.content,
        expectedHash: response.canonicalPlan.contentHash,
        savedContent: response.canonicalPlan.content,
      });
      setStatus((current) => current ? {
        ...current,
        required: false,
        completed: true,
        canonicalPlan: response.canonicalPlan,
        canonicalTaskCount: response.taskCount,
        taskCount: current.taskCount + response.createdTaskCount,
      } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prepare tasks from the plan');
    } finally {
      setPreparing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[28rem] items-center justify-center text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Inspecting project plans…
      </div>
    );
  }

  if (!status || !editor) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-5 text-sm text-danger">
          <p>{error || 'Project setup is unavailable.'}</p>
          <button type="button" onClick={() => void load()} className="mt-3 inline-flex items-center gap-2 font-medium underline">
            <RefreshCw className="h-4 w-4" /> Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-6 py-6">
      <header className="border-b border-border pb-4">
        <div className="mb-2 inline-flex rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
          Project setup
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Turn your project plan into work</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Coleo searched the repository for likely plans. Review or edit the source below, then let the Brain
          prepare the canonical plan and create tasks. No Arm Host process is launched by this screen.
        </p>
      </header>

      <div className="grid gap-5 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">Files found</h2>
              <span className="text-xs text-muted-foreground">{status.candidates.length}</span>
            </div>
            <div className="mt-3 space-y-2">
              {status.candidates.length === 0 ? (
                <p className="rounded-lg bg-surface-secondary p-3 text-sm text-muted-foreground">
                  No likely plan files were found. Start a new plan and write in plain language.
                </p>
              ) : status.candidates.map((candidate) => (
                <button
                  key={candidate.path}
                  type="button"
                  onClick={() => selectCandidate(candidate)}
                  className={`w-full rounded-lg border p-3 text-left transition ${editor.path === candidate.path ? 'border-accent bg-accent/10' : 'border-border hover:bg-surface-secondary'}`}
                >
                  <span className="block truncate font-mono text-xs text-foreground">{candidate.path}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{candidate.reasons.join(' · ')}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={createPlan}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-surface-secondary"
            >
              <FilePlus2 className="h-4 w-4" /> Create a new plan
            </button>
          </section>

          <section className="rounded-xl border border-border bg-surface p-4 text-sm">
            <h2 className="font-semibold">What happens next</h2>
            <ol className="mt-3 space-y-2 text-muted-foreground">
              <li>1. Your edited source file is saved.</li>
              <li>2. The Brain structures it as <code className="text-foreground">.project/plan.md</code>.</li>
              <li>3. Plan checklist items become pending tasks.</li>
              <li>4. You review Tasks before starting an arm.</li>
            </ol>
          </section>
        </aside>

        <section className="min-w-0 rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-semibold">Review plan</h2>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{editor.path}</p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs ${dirty ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success'}`}>
              {dirty ? 'Unsaved changes' : 'Saved'}
            </span>
          </div>

          <textarea
            aria-label="Project plan content"
            value={editor.content}
            onChange={(event) => setEditor((current) => current ? { ...current, content: event.target.value } : current)}
            className="mt-4 min-h-[32rem] w-full resize-y rounded-lg border border-border bg-surface-secondary p-4 font-mono text-sm leading-6 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            spellCheck
          />

          {error ? (
            <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
          ) : null}
          {result ? (
            <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
              <div className="flex items-start gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Project plan prepared</p>
                  <p className="mt-1 text-foreground/80">
                    {result.taskCount} tasks found; {result.createdTaskCount} new tasks created using {result.mode === 'ai' ? 'AI-assisted' : 'structured fallback'} formatting.
                  </p>
                  <button
                    type="button"
                    onClick={() => openWorkspaceRoute({ pathname: '/tasks', search: '' }, 'tab')}
                    className="mt-2 inline-block font-medium underline"
                  >
                    Review tasks
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {!result && status.completed ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm">
              <div className="flex items-center gap-2 text-success">
                <Check className="h-4 w-4" />
                <span>{status.taskCount || status.canonicalTaskCount} project tasks are ready for review.</span>
              </div>
              <button
                type="button"
                onClick={() => openWorkspaceRoute({ pathname: '/tasks', search: '' }, 'tab')}
                className="font-medium text-foreground underline"
              >
                Review tasks
              </button>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving || preparing}
              className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              onClick={() => void prepare()}
              disabled={!editor.content.trim() || saving || preparing}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {preparing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {preparing ? 'Preparing tasks…' : 'Prepare plan and create tasks'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
