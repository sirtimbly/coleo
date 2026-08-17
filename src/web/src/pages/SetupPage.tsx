/**
 * Specialized collaborative plan and project-document editor.
 *
 * The canonical plan is not treated as generic text: saving and preparing it
 * preserve content hashes, Brain reconciliation, task identities, and explicit
 * task-regeneration workflows.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, FilePlus2, Info, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';

import { SetupFileTree } from '@/components/SetupFileTree';
import { RegenerateTasksModal } from '@/components/RegenerateTasksModal';
import { SetupWorkspaceToolbar } from '@/components/SetupWorkspaceToolbar';
import {
  WorkbenchEmptyState,
  WorkbenchHeader,
  WorkbenchSurface,
} from '@/design-system/WorkbenchSurface';
import { usePageTitle } from '@/hooks/usePageTitle';
import { api, type ProjectSetupStatus } from '@/lib';
import { dismissProjectSetupHelp, hasDismissedProjectSetupHelp, markProjectSetupOpened } from '@/lib/project-setup-visit';
import { useWorkspaceOpenRoute } from '@/workspace/route-context';

import { filterSetupFilePaths, setupPathMatchesScope, type SetupFileScope } from './setup-file-scope';
import type { FileTreeRowDecoration } from '@pierre/trees';
import './setup-page.css';

const EDITABLE_FILE = /\.(md|markdown|txt|toml|jinja)$/i;
const TOOLBAR_SNAPSHOT_FILE = /^\.coleo\/state\/workbench\/toolbar-templates\/[^/]+\/[^/]+\.json$/i;
const MARKDOWN_FILE = /\.(md|markdown)$/i;
const TOML_FILE = /\.toml$/i;
const JINJA_FILE = /\.jinja$/i;
const JSON_FILE = /\.json$/i;
const PLAN_DIRECTORY = '.project';
const CANONICAL_PLAN_PATH = `${PLAN_DIRECTORY}/plan.md`;
const TEMPLATE_DIRECTORY = '.coleo/templates';
const EXPANDED_DIRECTORIES = [PLAN_DIRECTORY, '.coleo', TEMPLATE_DIRECTORY] as const;

interface EditorState {
  path: string;
  content: string;
  expectedHash: string | null;
  savedContent: string;
  readOnly: boolean;
}

function isOpenableFile(path: string): boolean {
  return EDITABLE_FILE.test(path) || TOOLBAR_SNAPSHOT_FILE.test(path);
}

function editorFromStatus(status: ProjectSetupStatus): EditorState {
  const selected = status.canonicalPlan
    ?? status.projectDocuments.find((document) => document.path === status.recommendedPath)
    ?? status.projectDocuments[0];
  if (selected) {
    return {
      path: selected.path,
      content: selected.content,
      expectedHash: selected.contentHash,
      savedContent: selected.content,
      readOnly: false,
    };
  }
  return {
    path: CANONICAL_PLAN_PATH,
    content: status.defaultContent,
    expectedHash: null,
    savedContent: '',
    readOnly: false,
  };
}

function formatLastUpdated(value: string | undefined): string {
  if (!value) return 'Not saved yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function decorateSetupPath(path: string): FileTreeRowDecoration | null {
  if (path === PLAN_DIRECTORY || path.startsWith(`${PLAN_DIRECTORY}/`)) {
    return { text: '●', title: 'coleo-plan' };
  }
  if (path === TEMPLATE_DIRECTORY || path.startsWith(`${TEMPLATE_DIRECTORY}/`)) {
    return { text: '●', title: 'coleo-template' };
  }
  if (path === '.coleo' || path.startsWith('.coleo/')) {
    return { text: '●', title: 'coleo-config' };
  }
  return null;
}

function MarkdownPreview({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  const lines = content.split(/\r?\n/);
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(<p key={`p-${blocks.length}`} className="setup-markdown-paragraph">{paragraph.join(' ')}</p>);
      paragraph = [];
    }
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const task = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    const listItem = line.match(/^\s*[-*+]\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const Tag = `h${heading[1].length}` as 'h1' | 'h2' | 'h3';
      blocks.push(<Tag key={`h-${blocks.length}`} className="setup-markdown-heading">{heading[2]}</Tag>);
    } else if (task) {
      flushParagraph();
      blocks.push(<div key={`t-${blocks.length}`} className="setup-markdown-task"><Check className={`h-3.5 w-3.5 ${task[1].trim() ? 'text-success' : 'text-muted-foreground'}`} />{task[2]}</div>);
    } else if (listItem) {
      flushParagraph();
      blocks.push(<div key={`l-${blocks.length}`} className="setup-markdown-list">{listItem[1]}</div>);
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  return <div className="setup-markdown-preview">{blocks.length ? blocks : <p className="text-muted-foreground">No content yet.</p>}</div>;
}

export function SetupPage() {
  usePageTitle('Coleo Observatory - Project Setup');
  const openWorkspaceRoute = useWorkspaceOpenRoute();
  const [status, setStatus] = useState<ProjectSetupStatus | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [showRegeneratedTasksBanner, setShowRegeneratedTasksBanner] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [fileScope, setFileScope] = useState<SetupFileScope>('all');
  const [helpOpen, setHelpOpen] = useState(() => !hasDismissedProjectSetupHelp());
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [result, setResult] = useState<{
    mode: 'ai' | 'structured';
    taskCount: number;
    formatterError?: string;
  } | null>(null);
  const [openedModifiedAt, setOpenedModifiedAt] = useState<Map<string, string>>(() => new Map());
  const requestedPathRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getProjectSetupStatus();
      const nextStatus: ProjectSetupStatus = {
        ...response,
        projectDocuments: response.projectDocuments ?? [],
        projectTree: response.projectTree ?? [],
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
  const projectTree = status?.projectTree;
  const editorPath = editor?.path;
  const treePaths = useMemo(() => {
    const paths = projectTree ?? [];
    if (!editorPath || paths.includes(editorPath)) return paths;
    return [...paths, editorPath].sort();
  }, [editorPath, projectTree]);
  const scopedTreePaths = useMemo(
    () => filterSetupFilePaths(treePaths, fileScope, CANONICAL_PLAN_PATH),
    [fileScope, treePaths],
  );
  const modifiedAtByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const document of status?.projectDocuments ?? []) map.set(document.path, document.modifiedAt);
    for (const [path, modifiedAt] of openedModifiedAt) map.set(path, modifiedAt);
    return map;
  }, [status, openedModifiedAt]);
  const recentProjectDocuments = useMemo(
    () => (status?.projectDocuments ?? []).filter((document) => (
      document.recentlyChanged && setupPathMatchesScope(document.path, fileScope, CANONICAL_PLAN_PATH)
    )).slice(0, 5),
    [fileScope, status],
  );

  const dismissHelp = () => {
    dismissProjectSetupHelp();
    setHelpOpen(false);
  };

  const loadFileIntoEditor = useCallback(async (path: string) => {
    requestedPathRef.current = path;
    setEditorLoading(true);
    try {
      const { file } = await api.getProjectSetupFile(path);
      if (requestedPathRef.current !== path) return;
      setOpenedModifiedAt((current) => new Map(current).set(file.path, file.modifiedAt));
      setEditor({
        path: file.path,
        content: file.content,
        expectedHash: file.contentHash,
        savedContent: file.content,
        readOnly: file.readOnly === true,
      });
    } catch (err) {
      if (requestedPathRef.current === path) {
        setError(err instanceof Error ? err.message : 'Failed to open the file');
      }
    } finally {
      if (requestedPathRef.current === path) setEditorLoading(false);
    }
  }, []);

  const changeFileScope = (nextScope: SetupFileScope) => {
    if (!editor || !status || nextScope === fileScope || saving) return;
    requestedPathRef.current = null;
    setEditorLoading(false);
    if (setupPathMatchesScope(editor.path, nextScope, CANONICAL_PLAN_PATH)) {
      setFileScope(nextScope);
      return;
    }

    const targetPath = nextScope === 'plan'
      ? CANONICAL_PLAN_PATH
      : nextScope === 'coleo'
        ? treePaths.find((path) => isOpenableFile(path) && setupPathMatchesScope(path, nextScope, CANONICAL_PLAN_PATH))
        : editor.path;
    if (!targetPath) {
      setFileScope(nextScope);
      setHint('No editable files are available in the .coleo directory.');
      return;
    }
    if (dirty && !window.confirm('Discard your unsaved edits and change the files shown?')) return;

    setFileScope(nextScope);
    setHint(null);
    setResult(null);
    setError(null);
    if (targetPath === CANONICAL_PLAN_PATH) {
      requestedPathRef.current = null;
      const canonicalPlan = status.canonicalPlan;
      setEditor(canonicalPlan ? {
        path: canonicalPlan.path,
        content: canonicalPlan.content,
        expectedHash: canonicalPlan.contentHash,
        savedContent: canonicalPlan.content,
        readOnly: false,
      } : {
        path: CANONICAL_PLAN_PATH,
        content: status.defaultContent,
        expectedHash: null,
        savedContent: '',
        readOnly: false,
      });
      return;
    }
    void loadFileIntoEditor(targetPath);
  };

  const selectPath = (path: string): boolean => {
    if (!editor || saving) return false;
    if (!isOpenableFile(path)) {
      setHint('Markdown, text, TOML, and Jinja files can be edited here. Generated toolbar JSON snapshots can also be opened read-only.');
      return false;
    }
    if (path === editor.path) return true;
    if (dirty && !window.confirm('Discard your unsaved edits and open another file?')) return false;
    setHint(null);
    setResult(null);
    setError(null);
    void loadFileIntoEditor(path);
    return true;
  };

  const selectDocument = (path: string) => {
    if (!editor || saving) return;
    if (dirty && !window.confirm('Discard your unsaved edits and open another file?')) return;
    setHint(null);
    setResult(null);
    setError(null);
    if (!setupPathMatchesScope(path, fileScope, CANONICAL_PLAN_PATH)) setFileScope('all');
    void loadFileIntoEditor(path);
  };

  const createPlan = () => {
    if (!status || saving) return;
    if (dirty && !window.confirm('Discard your unsaved edits and start a new plan?')) return;
    requestedPathRef.current = null;
    setEditorLoading(false);
    setEditor({
      path: CANONICAL_PLAN_PATH,
      content: status.defaultContent,
      expectedHash: status.canonicalPlan?.contentHash ?? null,
      savedContent: status.canonicalPlan?.content ?? '',
      readOnly: false,
    });
    setHint(null);
    setResult(null);
    setError(null);
    setFileScope('plan');
  };

  const save = async (): Promise<boolean> => {
    if (!editor) return false;
    if (editor.readOnly) {
      setError('Toolbar configuration snapshots are read-only. Edit them in Toolbar Playground.');
      return false;
    }
    setSaving(true);
    setError(null);
    const targetPath = editor.path;
    try {
      const response = await api.saveProjectSetupFile({
        path: editor.path,
        content: editor.content,
        expectedHash: editor.expectedHash,
        kind: 'document',
      });
      setEditor((current) => current?.path === targetPath ? {
        ...current,
        expectedHash: response.file.contentHash,
        savedContent: response.file.content,
      } : current);
      setStatus((current) => {
        if (!current) return current;
        const file = response.file;
        const existingDocument = current.projectDocuments.find((entry) => entry.path === file.path);
        const projectDocuments = existingDocument
          ? current.projectDocuments.map((entry) => entry.path === file.path ? { ...file, recentlyChanged: true } : entry)
          : current.projectDocuments;
        const projectTree = current.projectTree.includes(file.path)
          ? current.projectTree
          : [...current.projectTree, file.path].sort();
        return {
          ...current,
          canonicalPlan: file.path === CANONICAL_PLAN_PATH ? file : current.canonicalPlan,
          projectDocuments,
          projectTree,
        };
      });
      setOpenedModifiedAt((current) => new Map(current).set(response.file.path, response.file.modifiedAt));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the file');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const openRegeneration = async () => {
    if (dirty && !(await save())) return;
    setRegenerateOpen(true);
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
        formatterError: response.formatterError,
      });
      setEditor({
        path: response.canonicalPlan.path,
        content: response.canonicalPlan.content,
        expectedHash: response.canonicalPlan.contentHash,
        savedContent: response.canonicalPlan.content,
        readOnly: false,
      });
      setStatus((current) => current ? {
        ...current,
        required: false,
        completed: true,
        canonicalPlan: response.canonicalPlan,
        canonicalTaskCount: response.taskCount,
        taskCount: current.taskCount,
      } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prepare tasks from the plan');
    } finally {
      setPreparing(false);
    }
  };

  if (loading) {
    return (
      <WorkbenchSurface className="h-full border-0">
        <WorkbenchEmptyState
          title="Inspecting project documents"
          description="Loading the canonical plan, templates, and project checkout."
          icon={<LoaderCircle className="h-4 w-4 animate-spin" />}
        />
      </WorkbenchSurface>
    );
  }

  if (!status || !editor) {
    return (
      <WorkbenchSurface className="h-full border-0">
        <WorkbenchEmptyState
          title="Project documents are unavailable"
          description={error || 'Coleo could not inspect the project checkout.'}
          action={(
            <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 font-medium underline">
              <RefreshCw className="h-4 w-4" /> Try again
            </button>
          )}
        />
      </WorkbenchSurface>
    );
  }

  const isMarkdown = MARKDOWN_FILE.test(editor.path);
  const isToml = TOML_FILE.test(editor.path);
  const isJinja = JINJA_FILE.test(editor.path);
  const isJson = JSON_FILE.test(editor.path);
  const isCanonicalPlan = editor.path === CANONICAL_PLAN_PATH;

  return (
    <div className="setup-page-shell flex h-full min-h-0 flex-col bg-background">
      <WorkbenchHeader
        title="Project documents"
        description="Edit the canonical plan and the project files that inform Brain and Arm work."
      />
      <SetupWorkspaceToolbar
        fileScope={fileScope}
        visibleFileCount={scopedTreePaths.length}
        isCanonicalPlan={isCanonicalPlan}
        isMarkdown={isMarkdown}
        readOnly={editor.readOnly}
        dirty={dirty}
        saving={saving}
        preparing={preparing}
        hasContent={Boolean(editor.content.trim())}
        previewOpen={previewOpen}
        onFileScopeChange={changeFileScope}
        onRegenerate={() => void openRegeneration()}
        onHelp={() => setHelpOpen(true)}
        onSave={() => void save()}
        onPrepare={() => void prepare()}
        onPreviewChange={() => setPreviewOpen((current) => !current)}
      />

      {helpOpen ? (
        <div className="setup-help-bar" role="status">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p className="min-w-0 flex-1">
            Use Show to focus the tree on the canonical plan, the <code>.coleo/</code> directory, or all project files. Markdown, text, TOML, and Jinja
            files open for editing; generated toolbar JSON snapshots open read-only. <span className="text-accent">●</span> marks <code>{PLAN_DIRECTORY}/</code> plan files,{' '}
            <span className="text-success">●</span> marks <code>{TEMPLATE_DIRECTORY}/</code> Arm templates, and{' '}
            <span className="text-warning">●</span> marks the rest of <code>.coleo/</code> configuration.
            Preparing a plan creates project tasks.
          </p>
          <button
            type="button"
            aria-label="Dismiss setup help"
            title="Dismiss"
            onClick={dismissHelp}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      <div className="setup-file-workspace">
        <aside className="setup-file-sidebar">
          <section className="setup-file-browser">
            <div>
              {scopedTreePaths.length === 0 ? (
                <p className="rounded-md bg-surface-secondary p-2.5 text-xs leading-5 text-muted-foreground">
                  {fileScope === 'coleo'
                    ? 'No files were found in the .coleo directory.'
                    : 'The project directory is empty. Clone a repository or start a new plan to get going.'}
                </p>
              ) : (
                <div className="setup-file-tree-container">
                  <SetupFileTree
                    ariaLabel="Project checkout files"
                    paths={scopedTreePaths}
                    selectedPath={editor.path}
                    onSelect={selectPath}
                    expandedPaths={EXPANDED_DIRECTORIES}
                    decoratePath={decorateSetupPath}
                  />
                </div>
              )}
            </div>
            {hint ? (
              <p className="mt-2 rounded-md border border-border bg-surface-secondary p-2.5 text-xs leading-5 text-muted-foreground" role="status">
                {hint}
              </p>
            ) : null}
            {recentProjectDocuments.length > 0 ? (
              <div className="setup-recent-documents" aria-label="Recently changed project documents">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recently changed</p>
                {recentProjectDocuments.map((document) => (
                  <button key={document.path} type="button" onClick={() => selectDocument(document.path)} className="block w-full truncate rounded px-2 py-1 text-left text-xs text-accent hover:bg-accent/10">
                    {document.path.replace('.project/', '')}
                  </button>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              onClick={createPlan}
              disabled={saving || preparing}
              className="mt-1 inline-flex h-8 w-full items-center justify-start gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-surface-secondary hover:text-foreground"
            >
              <FilePlus2 className="h-3.5 w-3.5" /> New plan
            </button>
          </section>

        </aside>
        <section className="setup-file-editor min-w-0 rounded-md border border-border bg-surface p-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-muted-foreground">{editor.path}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">Last Updated: {formatLastUpdated(modifiedAtByPath.get(editor.path))}</p>
          </div>

          <div className={`setup-document-panes mt-2 ${previewOpen && isMarkdown ? '' : 'setup-document-panes--single'}`}>
          {editorLoading ? (
            <div className="flex min-h-[16rem] items-center justify-center text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Opening file…
            </div>
          ) : (
          <textarea
            aria-label={isMarkdown ? 'Markdown file content' : isToml ? 'TOML file content' : isJinja ? 'Jinja file content' : isJson ? 'Toolbar JSON snapshot' : 'Text file content'}
            value={editor.content}
            onChange={(event) => setEditor((current) => current ? { ...current, content: event.target.value } : current)}
            readOnly={editor.readOnly}
            className="setup-file-textarea mt-2 w-full resize-y rounded-md border border-border bg-surface-secondary p-3 font-mono text-sm leading-5 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent read-only:cursor-default read-only:text-muted-foreground"
            spellCheck={!isToml && !isJinja && !isJson}
          />
          )}
          {previewOpen && isMarkdown && !editorLoading ? <MarkdownPreview content={editor.content} /> : null}
          </div>

          {error ? (
            <div role="alert" className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
          ) : null}
          {result ? (
            <div role="status" className={`mt-2 rounded-md border px-3 py-2 text-xs ${result.formatterError ? 'border-warning/30 bg-warning/10 text-warning' : 'border-success/30 bg-success/10 text-success'}`}>
              <div className="flex items-start gap-2">
                {result.formatterError
                  ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
                <div>
                  <p className="font-medium">
                    {result.formatterError ? 'Plan prepared with structured fallback' : 'Project plan prepared'}
                  </p>
                  <p className="mt-1 text-foreground/80">
                    {result.taskCount} checklist items are ready in the canonical plan using {result.mode === 'ai' ? 'AI-assisted' : 'structured fallback'} formatting.
                  </p>
                  {result.formatterError ? (
                    <>
                      <p className="mt-1 text-foreground/80"><span className="font-medium text-warning">AI formatter problem:</span> {result.formatterError}</p>
                      <p className="mt-1 text-foreground/80">
                        The plan was saved, but the Brain has not accepted the AI evaluation, so its planning gate may remain blocked. The Brain will retry automatically; if this repeats, review the selected Brain model and plan-evaluation templates.
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-foreground/80">The Brain will analyze this file and create the tasks during its next poll.</p>
                  )}
                  {status.taskCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => openWorkspaceRoute({ pathname: '/tasks', search: '' }, 'tab')}
                      className="mt-2 inline-block font-medium underline"
                    >
                      Review existing tasks
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
          {!result && showRegeneratedTasksBanner && editor.path === CANONICAL_PLAN_PATH && status.taskCount > 0 ? (
            <div role="status" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs">
              <div className="flex items-center gap-2 text-success">
                <Check className="h-4 w-4" />
                <span>{status.taskCount} project tasks are ready for review.</span>
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
        </section>
      </div>
      <RegenerateTasksModal
        isOpen={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
        onRegenerated={() => {
          setShowRegeneratedTasksBanner(true);
          void load();
        }}
      />
    </div>
  );
}
