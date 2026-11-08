import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface WorkspaceSelection {
  directory: string;
  workspace: string;
  origin: string;
  found: boolean;
}
interface WorkspaceOptions { dir?: string; workspace?: string }
function projectRuntime(workspace: string): string | undefined {
  let content: string;
  try { content = readFileSync(join(workspace, ".env"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const match = content.match(/^\s*(?:export\s+)?COLEO_DIR\s*=([^\r\n]*)/m);
  const value = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
  return value ? resolve(workspace, value) : undefined;
}
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
  if (options.workspace || env.COLEO_PROJECT_DIR) {
    const workspace = resolve(cwd, options.workspace || env.COLEO_PROJECT_DIR!);
    const directory = projectRuntime(workspace) || join(workspace, ".coleo");
    return { directory, workspace, origin: options.workspace ? "flag:--workspace" : "environment:COLEO_PROJECT_DIR", found: isDirectory(directory) };
  }
  let current = resolve(cwd);
  while (true) {
    const configured = projectRuntime(current);
    if (configured) return { directory: configured, workspace: current, origin: `${join(current, ".env")}:COLEO_DIR`, found: isDirectory(configured) };
    const directory = join(current, ".coleo");
    if (isDirectory(directory)) return { directory, workspace: current, origin: "discovered", found: true };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { directory: join(resolve(cwd), ".coleo"), workspace: resolve(cwd), origin: "default:current-directory", found: false };
}
