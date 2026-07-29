import { useEffect, useRef } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';

import type { FileTreeDirectoryHandle, FileTreeRowDecoration } from '@pierre/trees';

interface SetupFileTreeProps {
  ariaLabel: string;
  paths: readonly string[];
  selectedPath: string;
  onSelect: (path: string) => boolean;
  expandedPaths?: readonly string[];
  decoratePath?: (path: string, kind: 'directory' | 'file') => FileTreeRowDecoration | null;
}

type TreeModel = ReturnType<typeof useFileTree>['model'];

function getAncestorDirectoryPaths(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

function expandPathAncestors(model: TreeModel, path: string): void {
  for (const ancestorPath of getAncestorDirectoryPaths(path)) {
    const item = model.getItem(ancestorPath);
    if (!item?.isDirectory()) continue;
    const directory = item as FileTreeDirectoryHandle;
    if (!directory.isExpanded()) directory.expand();
  }
}

// Trees detects overflow with a height container query. Fractional browser scaling can
// make a single 24px line measure slightly above 24px, so allow a pixel of rounding
// tolerance before showing its truncation marker.
const TRUNCATION_TOLERANCE_CSS = `
  [data-truncate-marker] {
    opacity: 0;
  }

  @container measure (height > calc(1lh + 1px)) {
    [data-truncate-marker] {
      opacity: 1;
    }
  }

  [data-item-section="decoration"] span[title="coleo-plan"] {
    color: var(--accent);
    font-size: 0.65rem;
    line-height: 1;
  }

  [data-item-section="decoration"] span[title="coleo-template"] {
    color: var(--success);
    font-size: 0.65rem;
    line-height: 1;
  }

  [data-item-section="decoration"] span[title="coleo-config"] {
    color: var(--warning);
    font-size: 0.65rem;
    line-height: 1;
  }
`;

export function SetupFileTree({ ariaLabel, paths, selectedPath, onSelect, expandedPaths, decoratePath }: SetupFileTreeProps) {
  const modelRef = useRef<TreeModel | null>(null);
  const selectedPathRef = useRef(selectedPath);
  const onSelectRef = useRef(onSelect);
  const decoratePathRef = useRef(decoratePath);
  selectedPathRef.current = selectedPath;
  onSelectRef.current = onSelect;
  decoratePathRef.current = decoratePath;

  const { model } = useFileTree({
    paths,
    density: 'compact',
    flattenEmptyDirectories: true,
    icons: { set: 'minimal', colored: false },
    initialExpansion: 1,
    initialExpandedPaths: expandedPaths,
    initialSelectedPaths: paths.includes(selectedPath) ? [selectedPath] : [],
    unsafeCSS: TRUNCATION_TOLERANCE_CSS,
    renderRowDecoration: ({ row }) => decoratePathRef.current?.(row.path, row.kind) ?? null,
    onSelectionChange: (selectedPaths) => {
      const nextPath = [...selectedPaths].reverse().find((path) => paths.includes(path));
      if (!nextPath || nextPath === selectedPathRef.current) return;
      if (onSelectRef.current(nextPath)) return;

      queueMicrotask(() => {
        const currentModel = modelRef.current;
        if (!currentModel) return;
        for (const path of currentModel.getSelectedPaths()) currentModel.getItem(path)?.deselect();
        currentModel.getItem(selectedPathRef.current)?.select();
      });
    },
  });
  modelRef.current = model;

  useEffect(() => {
    const knownDirectories = new Set(paths.flatMap(getAncestorDirectoryPaths));
    const currentlyExpanded = [...knownDirectories].filter((path) => {
      const item = model.getItem(path);
      return item?.isDirectory() && (item as FileTreeDirectoryHandle).isExpanded();
    });
    model.resetPaths(paths, {
      initialExpandedPaths: [
        ...new Set([
          ...currentlyExpanded,
          ...(expandedPaths ?? []),
          ...getAncestorDirectoryPaths(selectedPathRef.current),
        ]),
      ],
    });
  }, [model, paths, expandedPaths]);

  useEffect(() => {
    if (!expandedPaths) return;
    for (const path of expandedPaths) {
      const item = model.getItem(path);
      if (!item?.isDirectory()) continue;
      const directory = item as FileTreeDirectoryHandle;
      if (!directory.isExpanded()) directory.expand();
    }
  }, [model, paths, expandedPaths]);

  useEffect(() => {
    if (!paths.includes(selectedPath)) return;
    expandPathAncestors(model, selectedPath);
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedPath) model.getItem(path)?.deselect();
    }
    const item = model.getItem(selectedPath);
    if (item && !item.isSelected()) item.select();
    model.scrollToPath(selectedPath, { focus: false, offset: 'nearest' });
  }, [model, paths, selectedPath]);

  return (
    <FileTree
      aria-label={ariaLabel}
      className="setup-file-tree"
      model={model}
    />
  );
}
