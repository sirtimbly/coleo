import type { ReactNode } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components';
import type {
  GardenScene,
  GardenSceneAnchor,
  GardenSceneArm,
  GardenSceneBrain,
  GardenSceneBubble,
  GardenSceneBug,
  GardenSceneTask,
} from '@/lib/api';

import type { GardenSelection } from './types';

interface GardenInspectorProps {
  scene: GardenScene | undefined;
  selection: GardenSelection | null;
}

function formatTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function renderKeyValue(label: string, value: string | number | null | undefined) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right text-foreground">{value ?? 'Unknown'}</span>
    </div>
  );
}

function resolveSelection(
  scene: GardenScene,
  selection: GardenSelection,
):
  | { title: string; subtitle: string; body: ReactNode }
  | null {
  switch (selection.kind) {
    case 'brain': {
      const brain: GardenSceneBrain = scene.brain;
      return {
        title: brain.label,
        subtitle: 'Coordinator nucleus',
        body: (
          <div className="space-y-2">
            {renderKeyValue('Status', brain.status)}
            {renderKeyValue('Poll interval', `${Math.round(brain.pollIntervalMs / 1000)}s`)}
            {renderKeyValue('Pending tasks', brain.pendingTasks)}
            {renderKeyValue('Completed today', brain.completedToday)}
            {renderKeyValue('Completed total', brain.completedTaskCount)}
            {renderKeyValue('Last poll', formatTimestamp(brain.lastPollAt))}
          </div>
        ),
      };
    }
    case 'anchor': {
      const anchor: GardenSceneAnchor | undefined = scene.anchors.find((item) => item.id === selection.id);
      if (!anchor) return null;
      return {
        title: anchor.label,
        subtitle: `${anchor.kind} anchor`,
        body: (
          <div className="space-y-2">
            {renderKeyValue('Attached items', anchor.itemCount)}
            {renderKeyValue('Position', `${anchor.position.x.toFixed(1)}, ${anchor.position.y.toFixed(1)}, ${anchor.position.z.toFixed(1)}`)}
          </div>
        ),
      };
    }
    case 'arm': {
      const arm: GardenSceneArm | undefined = scene.arms.find((item) => item.id === selection.id);
      if (!arm) return null;
      return {
        title: arm.label,
        subtitle: 'Arm swimmer',
        body: (
          <div className="space-y-2">
            {renderKeyValue('Legacy status', arm.legacyStatus)}
            {renderKeyValue('Lifecycle state', arm.lifecycleState)}
            {renderKeyValue('Domain', arm.domain)}
            {renderKeyValue('Current task', arm.currentTaskId)}
            {renderKeyValue('Current bug', arm.currentBugId)}
            {renderKeyValue('Workspace anchor', arm.targetAnchorId)}
            {renderKeyValue('Last activity', formatTimestamp(arm.lastActivityAt))}
            {renderKeyValue('Last heartbeat', formatTimestamp(arm.lastHeartbeatAt))}
            {renderKeyValue('Last output', formatTimestamp(arm.lastOutputAt))}
            {renderKeyValue('Workdir', arm.workdir)}
          </div>
        ),
      };
    }
    case 'task': {
      const task: GardenSceneTask | undefined = scene.tasks.find((item) => item.id === selection.id);
      if (!task) return null;
      return {
        title: task.label,
        subtitle: 'Task frond',
        body: (
          <div className="space-y-2">
            {renderKeyValue('Status', task.status)}
            {renderKeyValue('Priority', task.priority)}
            {renderKeyValue('Domain', task.domain)}
            {renderKeyValue('Classification', task.classification)}
            {renderKeyValue('Phase', task.phase)}
            {renderKeyValue('Assigned arm', task.assignedTo)}
            {renderKeyValue('Progress', task.progress == null ? 'Unknown' : `${task.progress}%`)}
            {renderKeyValue('Updated', formatTimestamp(task.updatedAt))}
          </div>
        ),
      };
    }
    case 'bug': {
      const bug: GardenSceneBug | undefined = scene.bugs.find((item) => item.id === selection.id);
      if (!bug) return null;
      return {
        title: bug.label,
        subtitle: 'Bug urchin',
        body: (
          <div className="space-y-2">
            {renderKeyValue('Status', bug.status)}
            {renderKeyValue('Priority', bug.priority)}
            {renderKeyValue('Assignee arm', bug.assigneeArmId)}
            {renderKeyValue('Source task', bug.sourceTaskId)}
          </div>
        ),
      };
    }
    case 'bubble': {
      const bubble: GardenSceneBubble | undefined = scene.bubbles.find((item) => item.id === selection.id);
      if (!bubble) return null;
      return {
        title: bubble.label,
        subtitle: `${bubble.kind} bubble`,
        body: (
          <div className="space-y-2">
            {renderKeyValue('Status', bubble.status)}
            {renderKeyValue('Severity', bubble.severity)}
            {renderKeyValue('Phase', bubble.phase)}
            {renderKeyValue('Task', bubble.taskId)}
            {renderKeyValue('Source arm', bubble.sourceArmId)}
          </div>
        ),
      };
    }
    default:
      return null;
  }
}

export function GardenInspector({ scene, selection }: GardenInspectorProps) {
  const resolved = scene && selection ? resolveSelection(scene, selection) : null;

  return (
    <Card className="h-fit border-cyan-400/15 bg-slate-950/75 backdrop-blur">
      <CardHeader className="mb-3">
        <CardTitle className="text-cyan-50">Inspector</CardTitle>
        <CardDescription>
          Select a scene object to inspect its role in the garden.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!scene ? (
          <div className="text-sm text-muted-foreground">Loading scene data…</div>
        ) : !resolved ? (
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>The garden is organized around the brain, visible arm tips, and work clusters.</p>
            <p>Click the brain, an arm, a task, a bug, or a bubble to inspect it here.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-lg font-semibold text-foreground">{resolved.title}</div>
              <div className="text-sm text-cyan-200/80">{resolved.subtitle}</div>
            </div>
            {resolved.body}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
