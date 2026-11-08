import { useId, useMemo, useState } from 'react';
import { FilePlus2, FileText, Search, X } from 'lucide-react';
import { SetupFileTree } from './SetupFileTree';
import type { FileTreeRowDecoration } from '@pierre/trees';

interface SetupFileSidebarProps {
  paths: readonly string[];
  selectedPath: string;
  recentDocuments: { path: string }[];
  expandedPaths: readonly string[];
  decoratePath: (path: string) => FileTreeRowDecoration | null;
  onSelect: (path: string) => boolean;
  onSelectRecent: (path: string) => void;
  onCreate: () => void;
  busy: boolean;
  hint: string | null;
}

export function SetupFileSidebar({ paths, selectedPath, recentDocuments, expandedPaths, decoratePath,
  onSelect, onSelectRecent, onCreate, busy, hint }: SetupFileSidebarProps): React.JSX.Element {
  const id = useId();
  const [view, setView] = useState<'files' | 'recent'>('files');
  const [query, setQuery] = useState('');
  const matchingPaths = useMemo(() => {
    const candidates = view === 'recent' ? recentDocuments.map(document => document.path) : paths;
    const search = query.trim().toLocaleLowerCase();
    return search ? candidates.filter(path => path.toLocaleLowerCase().includes(search)) : candidates;
  }, [paths, recentDocuments, view, query]);

  return <aside className="setup-file-sidebar" aria-label="File browser">
    <div className="setup-browser-tabs" role="tablist" aria-label="Browse project documents">
      {(['files', 'recent'] as const).map(tab => <button key={tab} type="button" role="tab"
        id={`${id}-${tab}`} aria-controls={`${id}-panel`} aria-selected={view === tab}
        tabIndex={view === tab ? 0 : -1} onClick={() => setView(tab)}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'files' : event.key === 'End' ? 'recent' : tab === 'files' ? 'recent' : 'files';
          setView(next);
          document.getElementById(`${id}-${next}`)?.focus();
        }}>
        {tab === 'files' ? 'Files' : 'Recently changed'}
      </button>)}
    </div>
    <div className="setup-file-search">
      <Search size={14} aria-hidden="true" />
      <input type="search" aria-label="Find a file" placeholder="Find a file…" value={query}
        onChange={event => setQuery(event.target.value)} />
      {query ? <button type="button" aria-label="Clear file search" onClick={() => setQuery('')}><X size={14} /></button> : null}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${view}`} className="setup-browser-content">
      {matchingPaths.length === 0 ? <p className="setup-browser-empty">
        {query ? 'No files match your search.' : view === 'recent' ? 'No recently changed documents.' : 'No files in this view.'}
      </p> : view === 'files' && !query.trim() ? <div className="setup-file-tree-container">
        <SetupFileTree ariaLabel="Project checkout files" paths={matchingPaths} selectedPath={selectedPath}
          onSelect={onSelect} expandedPaths={expandedPaths} decoratePath={decoratePath} />
      </div> : <div className="setup-file-results" aria-label={view === 'recent' ? 'Recently changed project documents' : 'Matching files'}>
        {matchingPaths.map(path => <button key={path} type="button" title={path}
          aria-current={path === selectedPath ? 'page' : undefined}
          onClick={() => view === 'recent' ? onSelectRecent(path) : onSelect(path)}>
          <FileText size={14} aria-hidden="true" />
          <span><strong>{path.split('/').at(-1)}</strong><small>{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'Project root'}</small></span>
        </button>)}
      </div>}
    </div>
    {hint ? <p className="setup-browser-hint" role="status">{hint}</p> : null}
    <footer className="setup-browser-footer">
      <button type="button" onClick={onCreate} disabled={busy}><FilePlus2 size={14} /> New plan</button>
      <span>{matchingPaths.length.toLocaleString()} files</span>
    </footer>
  </aside>;
}
