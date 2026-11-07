import { statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface WorkspaceSelection {
  directory: string;
  workspace: string;
  origin: string;
  found: boolean;
}
interface WorkspaceOptions { dir?: string; workspace?: string }
function isDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) throw new Error(`Expected a runtime directory at ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Explicit selections win; otherwise walk upward to the nearest .coleo directory. */
export function discoverOpsWorkspace(options: WorkspaceOptions = {}, cwd = process.cwd(), env = process.env): WorkspaceSelection {
  const explicit = options.dir || env.COLEO_DIR;
  if (explicit) {
    const directory = resolve(cwd, explicit);
    return { directory, workspace: resolve(cwd, options.workspace || (basename(directory) === ".coleo" ? dirname(directory) : cwd)),
      origin: options.dir ? "flag:--dir" : "environment:COLEO_DIR", found: isDirectory(directory) };
  }
  if (options.workspace) {
    const workspace = resolve(cwd, options.workspace);
    const directory = join(workspace, ".coleo");
    return { directory, workspace, origin: "flag:--workspace", found: isDirectory(directory) };
  }
  let current = resolve(cwd);
  while (true) {
    const directory = join(current, ".coleo");
    if (isDirectory(directory)) return { directory, workspace: current, origin: "discovered", found: true };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { directory: join(resolve(cwd), ".coleo"), workspace: resolve(cwd), origin: "default:current-directory", found: false };
}
