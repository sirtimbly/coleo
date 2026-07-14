import { useEffect, useRef } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';

interface SetupFileTreeProps {
  ariaLabel: string;
  paths: readonly string[];
  selectedPath: string;
  onSelect: (path: string) => boolean;
}

type TreeModel = ReturnType<typeof useFileTree>['model'];

export function SetupFileTree({ ariaLabel, paths, selectedPath, onSelect }: SetupFileTreeProps) {
  const modelRef = useRef<TreeModel | null>(null);
  const selectedPathRef = useRef(selectedPath);
  const onSelectRef = useRef(onSelect);
  selectedPathRef.current = selectedPath;
  onSelectRef.current = onSelect;

  const { model } = useFileTree({
    paths,
    density: 'compact',
    flattenEmptyDirectories: true,
    icons: { set: 'minimal', colored: false },
    initialExpansion: 2,
    initialSelectedPaths: paths.includes(selectedPath) ? [selectedPath] : [],
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
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    if (!paths.includes(selectedPath)) return;
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
