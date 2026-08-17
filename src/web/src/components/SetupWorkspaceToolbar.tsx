import { Button, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { CircleHelp, Eye, EyeOff, LoaderCircle, RefreshCw, Save, Sparkles } from 'lucide-react';

import { ToolbarTemplateRows } from '@/design-system/toolbar-template';
import { isSetupFileScope, type SetupFileScope } from '@/pages/setup-file-scope';
import { useToolbarTemplate } from '@/workbench/toolbar-template-context';

import type { ToolbarWidgetRegistry } from '@/design-system/toolbar-template';

const SCOPE_TOGGLE_CLASS = 'inline-flex h-7 min-h-7 items-center justify-center px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-default data-[selected=true]:bg-accent/20 data-[selected=true]:text-accent';

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
      <span className="inline-flex shrink-0 self-center text-xs tabular-nums text-muted-foreground">
        {visibleFileCount} {visibleFileCount === 1 ? 'file' : 'files'} shown
      </span>
    ),
    'plan-documents.scope': (
      <ToggleButtonGroup
        aria-label="Files shown"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[fileScope]}
        onSelectionChange={(keys) => {
          const nextScope = [...keys][0];
          if (isSetupFileScope(nextScope)) onFileScopeChange(nextScope);
        }}
        size="sm"
        isDisabled={saving || preparing}
        className="inline-flex items-center"
      >
        <ToggleButton id="plan" variant="ghost" className={SCOPE_TOGGLE_CLASS}>Plan</ToggleButton>
        <ToggleButton id="coleo" variant="ghost" className={SCOPE_TOGGLE_CLASS}>
          Coleo dir
        </ToggleButton>
        <ToggleButton id="all" variant="ghost" className={SCOPE_TOGGLE_CLASS}>All files</ToggleButton>
      </ToggleButtonGroup>
    ),
    'plan-documents.regenerate-tasks': isCanonicalPlan ? (
      <Button
        variant="outline"
        size="sm"
        onPress={onRegenerate}
        isDisabled={saving || preparing}
        className="h-8 border-warning/50 px-2.5 text-xs font-normal text-warning hover:bg-warning/10"
      >
        <RefreshCw className="h-4 w-4" /> Regenerate All Tasks
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
      <Button
        size="sm"
        variant={previewOpen ? 'secondary' : 'ghost'}
        aria-pressed={previewOpen}
        aria-label={previewOpen ? 'Hide markdown preview' : 'Show markdown preview'}
        onPress={onPreviewChange}
        className="h-7 min-h-7 px-2"
      >
        {previewOpen ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        Preview
      </Button>
    ) : null,
    'plan-documents.document-status': (
      <span
        role="status"
        className={`inline-flex shrink-0 self-center px-2 py-0.5 text-[11px] ${readOnly ? 'bg-accent/10 text-accent' : dirty ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success'}`}
      >
        {readOnly ? 'Read-only snapshot' : dirty ? 'Unsaved changes' : 'Saved'}
      </span>
    ),
  };

  return <ToolbarTemplateRows template={template} widgets={widgets} />;
}
