import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, FileCode2, FilePlus2, FileText, LoaderCircle, RefreshCw, Save, Sparkles } from 'lucide-react';

import { SetupFileTree } from '@/components/SetupFileTree';
import { usePageTitle } from '@/hooks/usePageTitle';
import { api, type ArmTemplateFile, type ProjectPlanCandidate, type ProjectSetupStatus } from '@/lib';
import { markProjectSetupOpened } from '@/lib/project-setup-visit';
import { useWorkspaceOpenRoute } from '@/workspace/route-context';
import './setup-page.css';

type SetupFileKind = 'plan' | 'template';

const FALLBACK_ARM_TEMPLATE = `arm:
  name: new-arm
  domain: general
  harness: opencode-api

`;

interface EditorState {
  kind: SetupFileKind;
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
      kind: 'plan',
      path: selected.path,
      content: selected.content,
      expectedHash: selected.contentHash,
      savedContent: selected.content,
    };
  }
  return {
    kind: 'plan',
    path: '.project/plan.md',
    content: status.defaultContent,
    expectedHash: null,
    savedContent: '',
  };
}

function editorFromCandidate(candidate: ProjectPlanCandidate): EditorState {
  return {
    kind: 'plan',
    path: candidate.path,
    content: candidate.content,
    expectedHash: candidate.contentHash,
    savedContent: candidate.content,
  };
}

function editorFromTemplate(template: ArmTemplateFile): EditorState {
  return {
    kind: 'template',
    path: template.path,
    content: template.content,
    expectedHash: template.contentHash,
    savedContent: template.content,
  };
}

function nextTemplatePath(templates: ArmTemplateFile[]): string {
  const paths = new Set(templates.map((template) => template.path));
  let suffix = 1;
  while (paths.has(`.coleo/templates/new-arm${suffix === 1 ? '' : `-${suffix}`}.yml`)) suffix += 1;
  return `.coleo/templates/new-arm${suffix === 1 ? '' : `-${suffix}`}.yml`;
}

export function SetupPage() {
  usePageTitle('Coleo Observatory - Project Setup');
  const openWorkspaceRoute = useWorkspaceOpenRoute();
  const [status, setStatus] = useState<ProjectSetupStatus | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [activeKind, setActiveKind] = useState<SetupFileKind>('plan');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ mode: 'ai' | 'structured'; taskCount: number; createdTaskCount: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getProjectSetupStatus();
      const nextStatus: ProjectSetupStatus = {
        ...response,
        templateFiles: response.templateFiles ?? [],
        defaultTemplateContent: response.defaultTemplateContent ?? FALLBACK_ARM_TEMPLATE,
      };
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
  const activeFiles = useMemo(
    () => activeKind === 'plan' ? status?.candidates ?? [] : status?.templateFiles ?? [],
    [activeKind, status],
  );
  const activePaths = useMemo(() => activeFiles.map((file) => file.path), [activeFiles]);

  const switchKind = (kind: SetupFileKind) => {
    if (!status || kind === activeKind) return;
    if (dirty && !window.confirm('Discard your unsaved edits and switch file groups?')) return;
    setActiveKind(kind);
    setEditor(kind === 'plan'
      ? editorFromStatus(status)
      : status.templateFiles[0]
        ? editorFromTemplate(status.templateFiles[0])
        : {
            kind: 'template',
            path: nextTemplatePath(status.templateFiles),
            content: status.defaultTemplateContent,
            expectedHash: null,
            savedContent: '',
          });
    setResult(null);
    setError(null);
  };

  const selectCandidate = (candidate: ProjectPlanCandidate | ArmTemplateFile): boolean => {
    if (dirty && !window.confirm('Discard your unsaved edits and open another file?')) return false;
    setEditor('format' in candidate ? editorFromTemplate(candidate) : editorFromCandidate(candidate));
    setResult(null);
    setError(null);
    return true;
  };

  const createPlan = () => {
    if (!status) return;
    if (dirty && !window.confirm('Discard your unsaved edits and start a new plan?')) return;
    setEditor({
      kind: 'plan',
      path: '.project/plan.md',
      content: status.defaultContent,
      expectedHash: status.canonicalPlan?.contentHash ?? null,
      savedContent: status.canonicalPlan?.content ?? '',
    });
    setResult(null);
    setError(null);
  };

  const createTemplate = () => {
    if (!status) return;
    if (dirty && !window.confirm('Discard your unsaved edits and start a new template?')) return;
    setEditor({
      kind: 'template',
      path: nextTemplatePath(status.templateFiles),
      content: status.defaultTemplateContent,
      expectedHash: null,
      savedContent: '',
    });
    setResult(null);
    setError(null);
  };

  const save = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.saveProjectSetupFile({
        path: editor.path,
        content: editor.content,
        expectedHash: editor.expectedHash,
        kind: editor.kind,
      });
      setEditor((current) => current ? {
        ...current,
        expectedHash: response.file.contentHash,
        savedContent: response.file.content,
      } : current);
      setStatus((current) => {
        if (!current || editor.kind !== 'template') return current;
        const file = { ...response.file, format: response.file.path.endsWith('.toml') ? 'toml' as const : 'yaml' as const };
        return {
          ...current,
          templateFiles: [...current.templateFiles.filter((entry) => entry.path !== file.path), file]
            .sort((left, right) => left.path.localeCompare(right.path)),
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to save the ${editor.kind}`);
    } finally {
      setSaving(false);
    }
  };

  const prepare = async () => {
    if (!editor || editor.kind !== 'plan') return;
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
        kind: 'plan',
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

  const selectPath = (path: string): boolean => {
    const file = activeFiles.find((entry) => entry.path === path);
    return file ? selectCandidate(file) : false;
  };

  return (
    <div className="setup-page-shell flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3" role="tablist" aria-label="Setup file group">
        <button
          type="button"
          role="tab"
          aria-selected={activeKind === 'plan'}
          onClick={() => switchKind('plan')}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${activeKind === 'plan' ? 'border-accent/50 bg-accent/10 text-accent' : 'border-transparent text-muted-foreground hover:bg-surface-secondary hover:text-foreground'}`}
        >
          <FileText className="h-3.5 w-3.5" /> Project plans
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeKind === 'template'}
          onClick={() => switchKind('template')}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${activeKind === 'template' ? 'border-accent/50 bg-accent/10 text-accent' : 'border-transparent text-muted-foreground hover:bg-surface-secondary hover:text-foreground'}`}
        >
          <FileCode2 className="h-3.5 w-3.5" /> Arm templates
        </button>
      </div>

      <div className="setup-file-workspace">
        <aside className="setup-file-sidebar space-y-3">
          <section className="rounded-md border border-border bg-surface p-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">{activeKind === 'plan' ? 'Plans found' : 'Templates found'}</h2>
              <span className="text-xs text-muted-foreground">{activeKind === 'plan' ? status.candidates.length : status.templateFiles.length}</span>
            </div>
            <div className="mt-2">
              {activeKind === 'plan' && status.candidates.length === 0 ? (
                <p className="rounded-md bg-surface-secondary p-2.5 text-xs leading-5 text-muted-foreground">
                  No likely plan files were found. Start a new plan and write in plain language.
                </p>
              ) : activeKind === 'template' && status.templateFiles.length === 0 ? (
                <p className="rounded-md bg-surface-secondary p-2.5 text-xs leading-5 text-muted-foreground">
                  No Arm templates were found. Create one to prefill settings when spawning an arm.
                </p>
              ) : (
                <div className="setup-file-tree-container">
                  <SetupFileTree
                    key={activeKind}
                    ariaLabel={activeKind === 'plan' ? 'Project plan files' : 'Arm template files'}
                    paths={activePaths}
                    selectedPath={editor.path}
                    onSelect={selectPath}
                  />
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={activeKind === 'plan' ? createPlan : createTemplate}
              className="mt-2.5 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-surface-secondary"
            >
              <FilePlus2 className="h-3.5 w-3.5" /> New {activeKind === 'plan' ? 'plan' : 'template'}
            </button>
          </section>

          <section className="rounded-md border border-border bg-surface p-3 text-xs">
            <h2 className="font-semibold">{activeKind === 'plan' ? 'What happens next' : 'How templates are used'}</h2>
            {activeKind === 'plan' ? (
              <ol className="mt-2 space-y-1.5 leading-5 text-muted-foreground">
                <li>1. Your edited source file is saved.</li>
                <li>2. The Brain structures it as <code className="text-foreground">.project/plan.md</code>.</li>
                <li>3. Plan checklist items become pending tasks.</li>
                <li>4. You review Tasks before starting an arm.</li>
              </ol>
            ) : (
              <p className="mt-2 leading-5 text-muted-foreground">
                YAML templates in <code className="text-foreground">.coleo/templates</code> appear in the Spawn Arm flow.
                Legacy TOML files in <code className="text-foreground">.coleo/arms</code> remain editable here too.
              </p>
            )}
          </section>
        </aside>

        <section className="setup-file-editor min-w-0 rounded-md border border-border bg-surface p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-semibold">Review {activeKind === 'plan' ? 'plan' : 'Arm template'}</h2>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{editor.path}</p>
            </div>
            <span className={`rounded px-2 py-0.5 text-[11px] ${dirty ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success'}`}>
              {dirty ? 'Unsaved changes' : 'Saved'}
            </span>
          </div>

          <textarea
            aria-label={activeKind === 'plan' ? 'Project plan content' : 'Arm template content'}
            value={editor.content}
            onChange={(event) => setEditor((current) => current ? { ...current, content: event.target.value } : current)}
            className="setup-file-textarea mt-3 w-full resize-y rounded-md border border-border bg-surface-secondary p-3 font-mono text-sm leading-5 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            spellCheck
          />

          {error ? (
            <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
          ) : null}
          {activeKind === 'plan' && result ? (
            <div className="mt-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
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
          {activeKind === 'plan' && !result && status.completed ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs">
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

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving || preparing}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? 'Saving…' : `Save ${activeKind === 'plan' ? 'draft' : 'template'}`}
            </button>
            {activeKind === 'plan' ? (
              <button
                type="button"
                onClick={() => void prepare()}
                disabled={!editor.content.trim() || saving || preparing}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {preparing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {preparing ? 'Preparing tasks…' : 'Prepare plan and create tasks'}
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
