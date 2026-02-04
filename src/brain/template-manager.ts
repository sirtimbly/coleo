import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import nunjucks from "nunjucks";

const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

/**
 * Get the path to brain templates in the installed package
 * This resolves relative to the compiled code location
 */
function getPackageTemplatesDir(): string {
  // When running from dist/index.js: __dirname = dist/
  // Templates are at dist/brain/templates/
  return join(__dirname, "brain", "templates");
}

export class BrainTemplateManager {
  private coleoDir: string;
  private logger: (message: string) => void;

  constructor(coleoDir: string, logger: (message: string) => void) {
    this.coleoDir = coleoDir;
    this.logger = logger;
  }

  /**
   * Load and render a template with optional context
   */
  async renderTemplate(
    templateName: string,
    context?: Record<string, unknown>
  ): Promise<string> {
    // Try local templates first (in .coleo/)
    const localTemplatePath = join(this.coleoDir, "src", "brain", "templates", templateName);
    try {
      const templateContent = await readFile(localTemplatePath, "utf-8");
      return context ? nunjucks.renderString(templateContent, context) : templateContent;
    } catch {
      // Local template not found, try package templates
      const packageTemplatePath = join(getPackageTemplatesDir(), templateName);
      try {
        const templateContent = await readFile(packageTemplatePath, "utf-8");
        return context ? nunjucks.renderString(templateContent, context) : templateContent;
      } catch (pkgErr) {
        this.logger(`Failed to load template ${templateName}: ${pkgErr}`);
        return `Template missing: ${templateName}`;
      }
    }
  }

  /**
   * Load and render the mail processor system prompt template
   */
  async loadMailProcessorSystemPrompt(context: {
    availableArms: Array<{ name: string; domain: string; status: string }>;
    pendingTasks: number;
    recentActivity: string[];
  }): Promise<string> {
    const availableArms = context.availableArms.map(a => `${a.name} (${a.status})`).join(", ") || "none";
    const recentActivity = context.recentActivity.slice(0, 5).join("; ") || "none";
    return this.renderTemplate("mail-processor-system-prompt.jinja", {
      available_arms: availableArms,
      pending_tasks: context.pendingTasks,
      recent_activity: recentActivity,
    });
  }

  /**
   * Load the initial arm prompt template
   */
  async loadInitialArmPrompt(): Promise<string> {
    return this.renderTemplate("initial-arm-prompt.jinja");
  }

  /**
   * Load and render the bug assignment prompt template
   */
  async loadBugAssignmentPrompt(context: {
    bugId: string;
    title: string;
    assignedBy: string;
    reason: string;
  }): Promise<string> {
    return this.renderTemplate("bug-assignment-prompt.jinja", {
      bug_id: context.bugId,
      bug_title: context.title,
      assigned_by: context.assignedBy,
      reason: context.reason,
    });
  }

  /**
   * Ensure template files exist, creating them from source if needed
   */
  async ensureTemplatesExist(): Promise<void> {
    const templateDir = join(this.coleoDir, "src", "brain", "templates");
    const packageTemplatesDir = getPackageTemplatesDir();
    
    // Get list of templates from the package
    const templateFiles = [
      "mail-processor-system-prompt.jinja",
      "initial-arm-prompt.jinja",
      "bug-assignment-prompt.jinja",
      "arm-api-restart-prompt.jinja",
      "arm-tasks-available-prompt.jinja",
      "arm-loop-compact-nudge.jinja",
      "arm-generic-nudge.jinja",
      "stuck-analyzer-system-prompt.jinja",
      "stuck-analyzer-user-prompt.jinja",
      "human-task-queued-busy.jinja",
      "human-mail-escalate.jinja",
      "human-bug-report-confirmation.jinja",
      "human-task-completed.jinja",
      "human-task-deferred.jinja",
      "human-task-blocked.jinja",
      "human-issues-found.jinja",
      "human-review-needed.jinja",
      "human-verification-needed.jinja",
      "human-discovery.jinja",
      "human-approval-request.jinja",
      "human-status-report.jinja",
      "human-tool-discovered.jinja",
      "human-doc-updated.jinja",
      "human-bug-high-priority.jinja",
      "human-task-resumed.jinja",
      "human-bug-medium-escalation.jinja",
      "human-file-change.jinja",
      "human-infra-issues.jinja",
      "human-arm-stuck.jinja",
      "human-arm-idle-loop.jinja",
      "human-arm-zombie-killed.jinja",
      "human-task-blocked-by-bugs.jinja",
    ];

    for (const templateName of templateFiles) {
      const destPath = join(templateDir, templateName);
      const sourcePath = join(packageTemplatesDir, templateName);
      try {
        await readFile(destPath, "utf-8");
        // Template exists, skip
      } catch {
        // Template doesn't exist, try to create from package
        try {
          const sourceContent = await readFile(sourcePath, "utf-8");
          await mkdir(templateDir, { recursive: true });
          await writeFile(destPath, sourceContent, "utf-8");
          this.logger(`Created template: ${templateName}`);
        } catch (sourceErr) {
          this.logger(`Could not create template ${templateName}: ${sourceErr}`);
        }
      }
    }
  }
}
