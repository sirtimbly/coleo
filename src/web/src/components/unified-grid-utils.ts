/**
 * Pure search-filter helpers for the unified resource grid.
 *
 * Kept separate from the view so the filtering behavior is testable
 * without a DOM and so the view stays a thin composition layer.
 */
import type { Discovery, Task } from "@/lib";

export function filterTasksBySearch<T extends Pick<Task, "subject" | "description" | "phase">>(
  tasks: T[],
  searchText: string,
): T[] {
  const search = searchText.trim().toLocaleLowerCase();
  if (!search) return tasks;
  return tasks.filter(
    (task) =>
      task.subject.toLocaleLowerCase().includes(search) ||
      task.description.toLocaleLowerCase().includes(search) ||
      task.phase?.toLocaleLowerCase().includes(search),
  );
}

export function filterDiscoveriesBySearch<T extends Pick<Discovery, "title" | "details">>(
  discoveries: T[],
  searchText: string,
): T[] {
  const search = searchText.trim().toLocaleLowerCase();
  if (!search) return discoveries;
  return discoveries.filter(
    (discovery) =>
      discovery.title.toLocaleLowerCase().includes(search) ||
      discovery.details.toLocaleLowerCase().includes(search),
  );
}
