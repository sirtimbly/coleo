/**
 * Branch and PR Workflow Manager
 * 
 * Handles automated branch creation, commit organization, and PR drafting
 * when an arm reaches a good stopping point.
 */

import { execSync } from "child_process";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getColeoDir } from "../config";

export interface BranchConfig {
  /** Base branch to branch from */
  baseBranch: string;
  /** Branch naming pattern */
  namingPattern: string;
  /** Whether to push immediately after creating */
  autoPush: boolean;
  /** Whether to create PR draft immediately */
  autoCreatePR: boolean;
}

export interface PRMetadata {
  title: string;
  description: string;
  taskId: string;
  taskSubject: string;
  commits: CommitInfo[];
  filesChanged: string[];
  testStatus: "passing" | "failing" | "not_run";
}

export interface CommitInfo {
  hash: string;
  message: string;
  files: string[];
  author: string;
  date: string;
}

export interface WorkflowResult {
  success: boolean;
  branchName?: string;
  prUrl?: string;
  commitCount?: number;
  error?: string;
  logs: string[];
}

export const DEFAULT_BRANCH_CONFIG: BranchConfig = {
  baseBranch: "master",
  namingPattern: "arm/{armId}/{taskId}-{timestamp}",
  autoPush: false,
  autoCreatePR: false,
};

/**
 * Generate a branch name based on the configured pattern
 */
export function generateBranchName(
  armId: string,
  taskId: string,
  taskSubject: string,
  config: BranchConfig = DEFAULT_BRANCH_CONFIG
): string {
  const timestamp = Date.now();
  const shortSubject = taskSubject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .substring(0, 30)
    .replace(/-+$/, "");
  
  return config.namingPattern
    .replace("{armId}", armId)
    .replace("{taskId}", taskId)
    .replace("{timestamp}", timestamp.toString())
    .replace("{shortSubject}", shortSubject);
}

/**
 * Create a new branch for the current work
 */
export async function createBranch(
  branchName: string,
  baseBranch: string = "master"
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if we're in a git repo
    execSync("git rev-parse --git-dir", { stdio: "pipe" });
    
    // Check if branch already exists
    try {
      execSync(`git rev-parse --verify ${branchName}`, { stdio: "pipe" });
      return { success: false, error: `Branch ${branchName} already exists` };
    } catch {
      // Branch doesn't exist, which is what we want
    }
    
    // Create and checkout the new branch
    execSync(`git checkout -b ${branchName} ${baseBranch}`, { stdio: "pipe" });
    
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Failed to create branch: ${message}` };
  }
}

/**
 * Organize commits by grouping related changes
 */
export async function organizeCommits(
  taskId: string,
  taskSubject: string
): Promise<{ success: boolean; commitsCreated: number; error?: string }> {
  const logs: string[] = [];
  
  try {
    // Get current git status
    const statusOutput = execSync("git status --porcelain", { encoding: "utf-8" });
    const lines = statusOutput.trim().split("\n").filter(Boolean);
    
    if (lines.length === 0) {
      return { success: true, commitsCreated: 0 };
    }
    
    // Categorize files
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];
    
    for (const line of lines) {
      const status = line.substring(0, 2);
      const file = line.substring(3);
      
      if (status[0] !== " " && status[0] !== "?") {
        staged.push(file);
      } else if (status[1] !== " " && status[1] !== "?") {
        unstaged.push(file);
      } else if (status === "??") {
        untracked.push(file);
      }
    }
    
    let commitsCreated = 0;
    
    // Stage and commit unstaged changes
    if (unstaged.length > 0) {
      execSync("git add -A", { stdio: "pipe" });
      const commitMessage = buildCommitMessage(taskId, taskSubject, "checkpoint", unstaged);
      execSync(`git commit -m "${commitMessage}"`, { stdio: "pipe" });
      commitsCreated++;
      logs.push(`Created checkpoint commit with ${unstaged.length} files`);
    }
    
    // Stage and commit untracked files
    if (untracked.length > 0) {
      execSync("git add -A", { stdio: "pipe" });
      const commitMessage = buildCommitMessage(taskId, taskSubject, "feature", untracked);
      execSync(`git commit -m "${commitMessage}"`, { stdio: "pipe" });
      commitsCreated++;
      logs.push(`Created feature commit with ${untracked.length} new files`);
    }
    
    return { success: true, commitsCreated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, commitsCreated: 0, error: `Failed to organize commits: ${message}` };
  }
}

/**
 * Build a conventional commit message
 */
function buildCommitMessage(
  taskId: string,
  taskSubject: string,
  type: "checkpoint" | "feature" | "fix" | "refactor",
  files: string[]
): string {
  const shortSubject = taskSubject.substring(0, 50);
  const filesSummary = files.length > 3 
    ? `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`
    : files.join(", ");
  
  return `${type}: ${shortSubject}

- ${filesSummary}

Refs: ${taskId}`;
}

/**
 * Push branch to remote
 */
export async function pushBranch(
  branchName: string,
  force: boolean = false
): Promise<{ success: boolean; error?: string }> {
  try {
    const forceFlag = force ? "-f" : "";
    execSync(`git push ${forceFlag} -u origin ${branchName}`, { stdio: "pipe" });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Failed to push branch: ${message}` };
  }
}

/**
 * Create PR draft metadata file
 */
export async function createPRDraft(
  metadata: PRMetadata,
  outputDir: string = join(getColeoDir(), "pr-drafts")
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  try {
    await mkdir(outputDir, { recursive: true });
    
    const timestamp = Date.now();
    const fileName = `pr-draft-${metadata.taskId}-${timestamp}.md`;
    const filePath = join(outputDir, fileName);
    
    const content = buildPRMarkdown(metadata);
    await writeFile(filePath, content, "utf-8");
    
    return { success: true, filePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Failed to create PR draft: ${message}` };
  }
}

/**
 * Build PR markdown content
 */
function buildPRMarkdown(metadata: PRMetadata): string {
  const commitsList = metadata.commits
    .map(c => `- ${c.hash.substring(0, 7)}: ${c.message.split("\n")[0]}`)
    .join("\n");
  
  const filesList = metadata.filesChanged
    .map(f => `- ${f}`)
    .join("\n");
  
  return `# ${metadata.title}

## Summary

${metadata.description}

## Task Reference

**Task ID**: ${metadata.taskId}  
**Task Subject**: ${metadata.taskSubject}

## Changes

### Commits

${commitsList}

### Files Changed

${filesList}

## Test Status

${metadata.testStatus === "passing" ? "✅ All tests passing" : metadata.testStatus === "failing" ? "❌ Tests failing" : "⚠️ Tests not run"}

## Checklist

- [ ] Code follows project style guidelines
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Self-review completed
- [ ] PR description is clear and comprehensive
`;
}

/**
 * Execute the full branch/PR workflow
 */
export async function executeBranchPRWorkflow(
  armId: string,
  taskId: string,
  taskSubject: string,
  config: BranchConfig = DEFAULT_BRANCH_CONFIG
): Promise<WorkflowResult> {
  const logs: string[] = [];
  
  try {
    // Generate branch name
    const branchName = generateBranchName(armId, taskId, taskSubject, config);
    logs.push(`Generated branch name: ${branchName}`);
    
    // Create branch
    const branchResult = await createBranch(branchName, config.baseBranch);
    if (!branchResult.success) {
      return { success: false, error: branchResult.error, logs };
    }
    logs.push(`Created branch: ${branchName}`);
    
    // Organize commits
    const commitResult = await organizeCommits(taskId, taskSubject);
    if (!commitResult.success) {
      return { success: false, error: commitResult.error, logs };
    }
    logs.push(`Organized ${commitResult.commitsCreated} commits`);
    
    // Push if configured
    if (config.autoPush) {
      const pushResult = await pushBranch(branchName);
      if (!pushResult.success) {
        logs.push(`Warning: Failed to push branch: ${pushResult.error}`);
      } else {
        logs.push(`Pushed branch to origin`);
      }
    }
    
    // Get commit info for PR draft
    const commits = getRecentCommits(commitResult.commitsCreated || 1);
    const filesChanged = getChangedFiles();
    
    // Create PR draft
    const prMetadata: PRMetadata = {
      title: taskSubject,
      description: `Changes for task ${taskId}`,
      taskId,
      taskSubject,
      commits,
      filesChanged,
      testStatus: "not_run",
    };
    
    const prResult = await createPRDraft(prMetadata);
    if (!prResult.success) {
      logs.push(`Warning: Failed to create PR draft: ${prResult.error}`);
    } else {
      logs.push(`Created PR draft: ${prResult.filePath}`);
    }
    
    return {
      success: true,
      branchName,
      commitCount: commitResult.commitsCreated,
      logs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logs.push(`Error: ${message}`);
    return { success: false, error: message, logs };
  }
}

/**
 * Get recent commits
 */
function getRecentCommits(count: number): CommitInfo[] {
  try {
    const output = execSync(
      `git log -${count} --pretty=format:"%H|%s|%an|%ai"`,
      { encoding: "utf-8" }
    );
    
    return output.trim().split("\n").map(line => {
      const parts = line.split("|");
      return {
        hash: parts[0] || "",
        message: parts[1] || "",
        author: parts[2] || "",
        date: parts[3] || "",
        files: [], // Would need separate command to get files
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get list of changed files
 */
function getChangedFiles(): string[] {
  try {
    const output = execSync(
      "git diff --name-only HEAD~1 HEAD",
      { encoding: "utf-8" }
    );
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
