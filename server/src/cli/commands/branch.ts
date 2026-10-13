/**
 * Branch and PR Workflow CLI Commands
 * 
 * Commands for managing automated branch creation, commit organization,
 * and PR drafting from the CLI.
 */

import { Command } from "commander";
import { generateBranchName, createBranch, organizeCommits, pushBranch, createPRDraft } from "../../brain/branch-pr-workflow";
import { execSync } from "child_process";

export function registerBranchCommands(program: Command): void {
  const branchCmd = program
    .command("branch")
    .description("Branch and PR workflow management");

  branchCmd
    .command("create <task-id>")
    .description("Create a feature branch for the current task")
    .option("-n, --name <name>", "Custom branch name (auto-generated if not provided)")
    .option("-b, --base <branch>", "Base branch to branch from", "master")
    .action(async (taskId: string, options: { name?: string; base: string }) => {
      try {
        const branchName = options.name || generateBranchName("cli", taskId, taskId);
        console.log(`Creating branch: ${branchName} from ${options.base}...`);
        
        const result = await createBranch(branchName, options.base);
        if (result.success) {
          console.log(`✅ Branch created: ${branchName}`);
        } else {
          console.error(`❌ Failed to create branch: ${result.error}`);
          process.exit(1);
        }
      } catch (error) {
        console.error("Error creating branch:", error);
        process.exit(1);
      }
    });

  branchCmd
    .command("commit <task-id>")
    .description("Organize and commit changes for the current task")
    .option("-m, --message <message>", "Commit message")
    .action(async (taskId: string, options: { message?: string }) => {
      try {
        console.log("Organizing commits...");
        const result = await organizeCommits(taskId, options.message || `Changes for ${taskId}`);
        
        if (result.success) {
          console.log(`✅ Commits organized: ${result.commitsCreated} commits created`);
        } else {
          console.error(`❌ Failed to organize commits: ${result.error}`);
          process.exit(1);
        }
      } catch (error) {
        console.error("Error organizing commits:", error);
        process.exit(1);
      }
    });

  branchCmd
    .command("push [branch-name]")
    .description("Push current or specified branch to remote")
    .option("-f, --force", "Force push")
    .action(async (branchName: string | undefined, options: { force?: boolean }) => {
      try {
        const targetBranch = branchName || execSync("git branch --show-current", { encoding: "utf-8" }).trim();
        console.log(`Pushing branch: ${targetBranch}...`);
        
        const result = await pushBranch(targetBranch, options.force || false);
        if (result.success) {
          console.log(`✅ Branch pushed: ${targetBranch}`);
        } else {
          console.error(`❌ Failed to push branch: ${result.error}`);
          process.exit(1);
        }
      } catch (error) {
        console.error("Error pushing branch:", error);
        process.exit(1);
      }
    });

  branchCmd
    .command("pr-draft <task-id>")
    .description("Create a PR draft for the current task")
    .option("-t, --title <title>", "PR title")
    .option("-d, --description <description>", "PR description")
    .action(async (taskId: string, options: { title?: string; description?: string }) => {
      try {
        const commits = getRecentCommits(5);
        const files = getChangedFiles();
        
        const result = await createPRDraft({
          title: options.title || `Changes for ${taskId}`,
          description: options.description || `Implementation for task ${taskId}`,
          taskId,
          taskSubject: options.title || taskId,
          commits,
          filesChanged: files,
          testStatus: "not_run",
        });
        
        if (result.success) {
          console.log(`✅ PR draft created: ${result.filePath}`);
        } else {
          console.error(`❌ Failed to create PR draft: ${result.error}`);
          process.exit(1);
        }
      } catch (error) {
        console.error("Error creating PR draft:", error);
        process.exit(1);
      }
    });

  branchCmd
    .command("workflow <task-id>")
    .description("Execute full branch/PR workflow for a task")
    .option("-n, --name <name>", "Custom branch name")
    .option("-b, --base <branch>", "Base branch", "master")
    .option("--push", "Push branch after creation")
    .option("--draft", "Create PR draft")
    .action(async (taskId: string, options: { 
      name?: string; 
      base: string; 
      push?: boolean; 
      draft?: boolean;
    }) => {
      try {
        console.log(`🚀 Starting branch/PR workflow for task: ${taskId}\n`);
        
        // Step 1: Create branch
        const branchName = options.name || generateBranchName("cli", taskId, taskId);
        console.log(`Step 1: Creating branch ${branchName}...`);
        const branchResult = await createBranch(branchName, options.base);
        if (!branchResult.success) {
          console.error(`❌ Branch creation failed: ${branchResult.error}`);
          process.exit(1);
        }
        console.log(`✅ Branch created\n`);
        
        // Step 2: Organize commits
        console.log("Step 2: Organizing commits...");
        const commitResult = await organizeCommits(taskId, `Changes for ${taskId}`);
        if (!commitResult.success) {
          console.error(`❌ Commit organization failed: ${commitResult.error}`);
          process.exit(1);
        }
        console.log(`✅ ${commitResult.commitsCreated} commits created\n`);
        
        // Step 3: Push if requested
        if (options.push) {
          console.log("Step 3: Pushing branch...");
          const pushResult = await pushBranch(branchName, false);
          if (!pushResult.success) {
            console.error(`⚠️ Push failed: ${pushResult.error}`);
          } else {
            console.log("✅ Branch pushed\n");
          }
        }
        
        // Step 4: Create PR draft if requested
        if (options.draft) {
          console.log("Step 4: Creating PR draft...");
          const commits = getRecentCommits(commitResult.commitsCreated || 1);
          const files = getChangedFiles();
          
          const draftResult = await createPRDraft({
            title: `Changes for ${taskId}`,
            description: `Implementation for task ${taskId}`,
            taskId,
            taskSubject: taskId,
            commits,
            filesChanged: files,
            testStatus: "not_run",
          });
          
          if (!draftResult.success) {
            console.error(`⚠️ PR draft creation failed: ${draftResult.error}`);
          } else {
            console.log(`✅ PR draft created: ${draftResult.filePath}\n`);
          }
        }
        
        console.log("🎉 Workflow completed successfully!");
        console.log(`Branch: ${branchName}`);
        console.log(`Commits: ${commitResult.commitsCreated}`);
        
      } catch (error) {
        console.error("Error executing workflow:", error);
        process.exit(1);
      }
    });
}

/**
 * Get recent commits
 */
function getRecentCommits(count: number): Array<{
  hash: string;
  message: string;
  author: string;
  date: string;
  files: string[];
}> {
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
        files: [],
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
