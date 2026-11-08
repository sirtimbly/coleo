import { Button } from '@heroui/react';
import { CircleHelp, Eye, LoaderCircle, RefreshCw, Save, Sparkles } from 'lucide-react';

import { ToolbarTemplateRow } from '@/design-system/toolbar-template';
import { ToolbarToggleButton } from '@/design-system/toolbar-toggle-button';
import { isSetupFileScope, type SetupFileScope } from '@/pages/setup-file-scope';
import { useToolbarTemplate } from '@/workbench/toolbar-template-context';

import type { ToolbarWidgetRegistry } from '@/design-system/toolbar-template';

export function SetupWorkspaceToolbar({
  fileScope,
  visibleFileCount,
  isCanonicalPlan,
  isMarkdown,
  readOnly,
  dirty,
  saving,
  preparing,
  hasContent,
  previewOpen,
  onFileScopeChange,
  onRegenerate,
  onHelp,
  onSave,
  onPrepare,
  onPreviewChange,
}: {
  fileScope: SetupFileScope;
  visibleFileCount: number;
  isCanonicalPlan: boolean;
  isMarkdown: boolean;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  preparing: boolean;
  hasContent: boolean;
  previewOpen: boolean;
  onFileScopeChange: (scope: SetupFileScope) => void;
  onRegenerate: () => void;
  onHelp: () => void;
  onSave: () => void;
  onPrepare: () => void;
  onPreviewChange: () => void;
}) {
  const template = useToolbarTemplate('plan-documents');
  const widgets: ToolbarWidgetRegistry = {
    'plan-documents.file-count': (
      <h1 className="setup-toolbar-title" title={`${visibleFileCount} files shown`}>Project documents</h1>
    ),
    'plan-documents.scope': (
      <select
        aria-label="Files shown"
        value={fileScope}
        onChange={(event) => {
          const nextScope = event.target.value;
          if (isSetupFileScope(nextScope)) onFileScopeChange(nextScope);
        }}
        disabled={saving || preparing}
        className="setup-scope-select"
      >
        <option value="plan">Plan</option>
        <option value="coleo">Coleo directory</option>
        <option value="all">All files</option>
      </select>
    ),
    'plan-documents.regenerate-tasks': isCanonicalPlan ? (
      <Button
        variant="outline"
        size="sm"
        onPress={onRegenerate}
        isDisabled={saving || preparing}
        className="h-8 px-2.5 text-xs font-normal"
        aria-label="Regenerate All Tasks"
      >
        <RefreshCw className="h-4 w-4" /> Regenerate
      </Button>
    ) : null,
    'plan-documents.help': (
      <Button isIconOnly size="sm" variant="ghost" aria-label="Show setup help" onPress={onHelp}>
        <CircleHelp className="h-4 w-4" />
      </Button>
    ),
    'plan-documents.save': (
      <Button size="sm" variant="outline" onPress={onSave} isDisabled={readOnly || !dirty || saving || preparing}>
        {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {saving ? 'Saving…' : 'Save'}
      </Button>
    ),
    'plan-documents.prepare-tasks': isCanonicalPlan ? (
      <Button size="sm" variant="primary" onPress={onPrepare} isDisabled={!hasContent || saving || preparing}>
        {preparing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {preparing ? 'Preparing…' : 'Prepare tasks'}
      </Button>
    ) : null,
    'plan-documents.preview': isMarkdown ? (
      <ToolbarToggleButton
        size="sm"
        isSelected={previewOpen}
        aria-label="Markdown preview"
        onPress={onPreviewChange}
        className="h-7 min-h-7 px-2"
      >
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        Preview
      </ToolbarToggleButton>
    ) : null,
    'plan-documents.document-status': (
      <span
        role="status"
        className={`inline-flex shrink-0 self-center text-xs ${readOnly ? 'text-accent' : dirty ? 'text-warning' : 'text-muted-foreground'}`}
      >
        {readOnly ? 'Read-only snapshot' : dirty ? 'Unsaved changes' : 'Saved'}
      </span>
    ),
  };

  return <div className="setup-workspace-toolbar">{template.rows.filter(row => row.items.some(item =>
    !item.hidden && (item.kind === 'label' || (item.kind === 'widget' && widgets[item.widget]))
  )).map(row => <ToolbarTemplateRow key={row.id} row={row} widgets={widgets} />)}</div>;
}
