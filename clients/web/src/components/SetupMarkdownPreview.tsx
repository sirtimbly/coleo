import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { Components } from 'react-markdown';

const plugins = [remarkGfm];
const components: Components = {
  table: ({ children }) => <div className="setup-markdown-table-scroll" tabIndex={0} role="region" aria-label="Markdown table"><table>{children}</table></div>,
};

export default function SetupMarkdownPreview({ content, expanded, onToggleExpanded }: {
  content: string;
  expanded: boolean;
  onToggleExpanded: () => void;
}): React.JSX.Element {
  return <section className="setup-markdown-preview" aria-label="Rendered Markdown">
    <div className="setup-preview-toolbar">
      <span>Preview</span>
      <button type="button" onClick={onToggleExpanded} aria-pressed={expanded}
        aria-label={expanded ? 'Return to split view' : 'Expand preview'}
        title={expanded ? 'Show source and preview' : 'Use the full editor width'}>
        {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        {expanded ? 'Split view' : 'Expand'}
      </button>
    </div>
    <div className="setup-markdown-body">
      {content.trim() ? <Markdown remarkPlugins={plugins} components={components} skipHtml>{content}</Markdown>
        : <p className="text-muted-foreground">No content yet.</p>}
    </div>
  </section>;
}
