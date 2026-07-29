import type { TaskListQueryData } from '@/hooks/useTasks';
import type { Task } from '@/lib/api';

export function patchTaskInQueryData(
  data: TaskListQueryData | undefined,
  taskId: string,
  changes: Partial<Task>,
  previousStatusHint?: Task['status'],
): TaskListQueryData | undefined {
  if (!data) return data;

  let previousStatus = previousStatusHint;
  let found = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const tasks = page.tasks.map((task) => {
      if (task.id !== taskId) return task;
      found = true;
      previousStatus = task.status;
      pageChanged = true;
      return { ...task, ...changes };
    });
    return pageChanged ? { ...page, tasks } : page;
  });

  const nextStatus = changes.status;
  if (nextStatus && previousStatus && nextStatus !== previousStatus) {
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]!;
      pages[index] = {
        ...page,
        counts: {
          ...page.counts,
          byStatus: {
            ...page.counts.byStatus,
            [previousStatus]: Math.max(0, (page.counts.byStatus[previousStatus] ?? 0) - 1),
            [nextStatus]: (page.counts.byStatus[nextStatus] ?? 0) + 1,
          },
        },
      };
    }
  }

  return found || (nextStatus && previousStatus && nextStatus !== previousStatus)
    ? { ...data, pages }
    : data;
}
