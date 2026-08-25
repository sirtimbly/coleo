/**
 * Public compatibility exports for route-level UI.
 *
 * New projection primitives live in design-system and workbench modules;
 * legacy exports remain here only while their containing pages are migrated.
 */

export { Layout } from './Layout';
export { StatusBadge } from './StatusBadge';
export { Card, CardHeader, CardTitle, CardContent, CardDescription } from './Card';
export { MessageComposer } from './MessageModal';
export { TaskModal } from './TaskModal';
export { RegenerateTasksModal } from './RegenerateTasksModal';
export { BugModal } from './BugModal';
export { ToastProvider, ToastContainer } from '../lib/toast.tsx';
export { TaskDiscussionPanel } from './TaskDiscussionPanel';
export { TaskSummaryPanel } from './TaskSummaryPanel';
export { TaskDiffPanel } from './TaskDiffPanel';
export { DiscussionItem } from './DiscussionItem';
export { DiscussionComposer } from './DiscussionComposer';
export { UnifiedGridView } from './UnifiedGridView';
export { ArmStatusBar } from './ArmStatusBar';
export { DenseSection, DenseRow, DenseRowSkeleton, DOT_TONE_CLASS, TEXT_TONE_CLASS, type Tone, type DenseRowProps } from './DenseList';
export { TaskProgressWidget } from './TaskProgressWidget';
export { TaskWorkflowHelp } from './TaskWorkflowHelp';
export { StatusBurndownChart } from './StatusBurndownChart';
export { CommandQueueChart } from './CommandQueueChart';
export { CollapsibleSection, type CollapsibleSectionProps } from './CollapsibleSection';
