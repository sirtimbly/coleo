import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

let root: string;
let source: string;
let workspace: string;
const script = resolve(import.meta.dir, "../../../docker/prepare-repository.sh");
const token = "11111111-1111-4111-8111-111111111111";
function git(...args: string[]): string { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function run(approved = false, extra: Record<string, string> = {}) {
  return spawnSync("bash", [script], { encoding: "utf8", env: {
    ...process.env, COLEO_WORKDIR: workspace, COLEO_GIT_REPO_URL: source,
    COLEO_GIT_REPLACEMENT_REQUEST: approved ? token : "", COLEO_GIT_REF: "", COLEO_GIT_CLONE_ARGS: "",
    COLEO_API_KEY: "test-only", COLEO_API_URL: "https://preview.invalid/internal",
    PATH: `${root}/bin:${process.env.PATH}`, ...extra,
  } });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coleo-repository-test-"));
  source = join(root, "source"); workspace = join(root, "workspace");
  mkdirSync(source); mkdirSync(workspace); mkdirSync(join(root, "bin"));
  git("init", source); git("-C", source, "config", "user.name", "Test"); git("-C", source, "config", "user.email", "test@example.invalid");
  writeFileSync(join(source, "tracked.txt"), "original"); git("-C", source, "add", "."); git("-C", source, "commit", "-m", "fixture");
  // Fake only the approval service; cloning and filesystem changes use real Git.
  writeFileSync(join(root, "bin/curl"), `#!/bin/sh\nprintf approved\n`, { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repository startup safety", () => {
  it("clones an empty workspace", () => {
    expect(run().status).toBe(0);
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("original");
  });
  it("preserves matching dirty checkout and untracked files even with approval", () => {
    git("clone", source, workspace);
    writeFileSync(join(workspace, "tracked.txt"), "local changes");
    writeFileSync(join(workspace, "notes"), "untracked");
    expect(run(true).status).toBe(0);
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("local changes");
    expect(readFileSync(join(workspace, "notes"), "utf8")).toBe("untracked");
    expect(existsSync(join(root, ".coleo-repository-backups"))).toBe(false);
  });
  it("keeps matching SSH checkouts and switches origin to the authenticated HTTPS transport", () => {
    git("clone", source, workspace);
    git("-C", workspace, "remote", "set-url", "origin", "git@github.com:owner/repo.git");
    writeFileSync(join(workspace, "notes"), "valuable");
    expect(run(false, { COLEO_GIT_REPO_URL: "https://github.com/owner/repo.git" }).status).toBe(0);
    expect(git("-C", workspace, "remote", "get-url", "origin")).toBe("https://github.com/owner/repo.git");
    expect(readFileSync(join(workspace, "notes"), "utf8")).toBe("valuable");
  });
  it("blocks populated non-Git directories without approval", () => {
    writeFileSync(join(workspace, "notes"), "valuable");
    expect(run().status).not.toBe(0);
    expect(readFileSync(join(workspace, "notes"), "utf8")).toBe("valuable");
  });
  it("blocks a mismatching repository", () => {
    git("clone", source, workspace); git("-C", workspace, "remote", "set-url", "origin", `${source}-other`);
    expect(run().status).not.toBe(0);
    expect(git("-C", workspace, "remote", "get-url", "origin")).toBe(`${source}-other`);
  });
  it("backs up all original files before confirmed replacement", () => {
    writeFileSync(join(workspace, "notes"), "valuable");
    expect(run(true).status).toBe(0);
    expect(existsSync(join(workspace, "notes"))).toBe(false);
    const backup = readdirSync(join(root, ".coleo-repository-backups"))[0]!;
    expect(readFileSync(join(root, ".coleo-repository-backups", backup, "workspace/notes"), "utf8")).toBe("valuable");
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("original");
  });
  it("leaves original files untouched when cloning fails", () => {
    writeFileSync(join(workspace, "notes"), "valuable");
    expect(run(true, { COLEO_GIT_REPO_URL: join(root, "missing") }).status).not.toBe(0);
    expect(readFileSync(join(workspace, "notes"), "utf8")).toBe("valuable");
    expect(readdirSync(root).some((name) => name.includes(".clone."))).toBe(false);
  });
  it("leaves originals untouched for expired or consumed approval", () => {
    writeFileSync(join(root, "bin/curl"), "#!/bin/sh\nexit 22\n", { mode: 0o755 });
    writeFileSync(join(workspace, "notes"), "valuable");
    expect(run(true).status).not.toBe(0);
    expect(readFileSync(join(workspace, "notes"), "utf8")).toBe("valuable");
  });
  it("recognizes a matching linked worktree with a .git file", () => {
    rmSync(workspace, { recursive: true });
    git("-C", source, "remote", "add", "origin", source);
    git("-C", source, "worktree", "add", "--detach", workspace);
    writeFileSync(join(workspace, "notes"), "valuable");
    expect(run().status).toBe(0);
    expect(readFileSync(join(workspace, "notes"), "utf8")).toBe("valuable");
  });
  it("rejects workspace symlinks even with approval", () => {
    rmSync(workspace, { recursive: true }); symlinkSync(source, workspace);
    expect(run(true).status).not.toBe(0);
    expect(run(true, { COLEO_WORKDIR: `${workspace}/` }).status).not.toBe(0);
    expect(readFileSync(join(source, "tracked.txt"), "utf8")).toBe("original");
  });
});
