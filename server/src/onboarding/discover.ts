import { readdir, lstat } from "node:fs/promises";
import { join, relative } from "node:path";

/** Bounded, read-only discovery; never traverse symlinks or dependency/runtime trees. */
export async function discoverRepositories(root: string): Promise<{ repositories: string[]; scanLimited: boolean }> {
  const repositories: string[] = [];
  const queue = [{ path: root, depth: 0 }];
  const ignored = new Set(["node_modules", "vendor", "dist", "build", "target", "__pycache__"]);
  let visited = 0;
  let scanLimited = false;
  while (queue.length && visited < 1000) {
    const current = queue.shift()!;
    visited++;
    try {
      const marker = await lstat(join(current.path, ".git")).catch(() => undefined);
      if (marker && (marker.isDirectory() || marker.isFile())) {
        repositories.push(relative(root, current.path) || ".");
        continue;
      }
      const entries = await readdir(current.path, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || ignored.has(entry.name)) continue;
        if (current.depth >= 4 || queue.length + visited >= 1000) { scanLimited = true; continue; }
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") scanLimited = true;
    }
  }
  return { repositories, scanLimited: scanLimited || queue.length > 0 };
}
