import { describe, expect, it } from 'bun:test';

import { patchTaskInQueryData } from '../src/lib/task-query-cache';

import type { TaskListQueryData } from '../src/hooks/useTasks';

function createData(): TaskListQueryData {
  return {
    pageParams: [0],
    pages: [{
      tasks: [{
        id: 'task-1',
        subject: 'Original',
        description: 'Description',
        status: 'pending',
        priority: 'normal',
        sourceType: 'manual',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
        metadata: {},
      }],
      pagination: { limit: 100, offset: 0, total: 1 },
      counts: { total: 1, byStatus: { pending: 1, completed: 0 } },
    }],
  };
}

describe('task query cache updates', () => {
  it('patches a loaded task without refetching its pages', () => {
    const result = patchTaskInQueryData(createData(), 'task-1', { subject: 'Updated' });
    expect(result?.pages[0]?.tasks[0]?.subject).toBe('Updated');
    expect(result?.pages[0]?.counts.byStatus).toEqual({ pending: 1, completed: 0 });
  });

  it('updates status counts when the task status changes', () => {
    const result = patchTaskInQueryData(createData(), 'task-1', { status: 'completed' });
    expect(result?.pages[0]?.counts.byStatus).toEqual({ pending: 0, completed: 1 });
  });

  it('preserves references when the task and status are unchanged', () => {
    const data = createData();
    expect(patchTaskInQueryData(data, 'missing', { subject: 'Updated' })).toBe(data);
  });

  it('updates counts for unloaded tasks when the previous status is provided', () => {
    const result = patchTaskInQueryData(
      createData(),
      'unloaded',
      { status: 'completed' },
      'pending',
    );
    expect(result?.pages[0]?.tasks[0]?.status).toBe('pending');
    expect(result?.pages[0]?.counts.byStatus).toEqual({ pending: 0, completed: 1 });
  });
});
