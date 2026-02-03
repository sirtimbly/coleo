import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import nunjucks from "nunjucks";

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
    const templatePath = join(this.coleoDir, "src", "brain", "templates", templateName);
    try {
      const templateContent = await readFile(templatePath, "utf-8");
      return context ? nunjucks.renderString(templateContent, context) : templateContent;
    } catch (err) {
      this.logger(`Failed to load template ${templateName}: ${err}`);
      return `Template missing: ${templateName}`;
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
    const templates = [
      { name: "mail-processor-system-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "mail-processor-system-prompt.jinja") },
      { name: "initial-arm-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "initial-arm-prompt.jinja") },
      { name: "bug-assignment-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "bug-assignment-prompt.jinja") },
      { name: "arm-api-restart-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "arm-api-restart-prompt.jinja") },
      { name: "arm-tasks-available-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "arm-tasks-available-prompt.jinja") },
      { name: "arm-loop-compact-nudge.jinja", source: join(process.cwd(), "src", "brain", "templates", "arm-loop-compact-nudge.jinja") },
      { name: "arm-generic-nudge.jinja", source: join(process.cwd(), "src", "brain", "templates", "arm-generic-nudge.jinja") },
      { name: "stuck-analyzer-system-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "stuck-analyzer-system-prompt.jinja") },
      { name: "stuck-analyzer-user-prompt.jinja", source: join(process.cwd(), "src", "brain", "templates", "stuck-analyzer-user-prompt.jinja") },
      { name: "human-task-queued-busy.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-queued-busy.jinja") },
      { name: "human-mail-escalate.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-mail-escalate.jinja") },
      { name: "human-bug-report-confirmation.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-bug-report-confirmation.jinja") },
      { name: "human-task-completed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-completed.jinja") },
      { name: "human-task-deferred.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-deferred.jinja") },
      { name: "human-task-blocked.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-blocked.jinja") },
      { name: "human-issues-found.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-issues-found.jinja") },
      { name: "human-review-needed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-review-needed.jinja") },
      { name: "human-verification-needed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-verification-needed.jinja") },
      { name: "human-discovery.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-discovery.jinja") },
      { name: "human-approval-request.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-approval-request.jinja") },
      { name: "human-status-report.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-status-report.jinja") },
      { name: "human-tool-discovered.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-tool-discovered.jinja") },
      { name: "human-doc-updated.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-doc-updated.jinja") },
      { name: "human-bug-high-priority.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-bug-high-priority.jinja") },
      { name: "human-task-resumed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-resumed.jinja") },
      { name: "human-bug-medium-escalation.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-bug-medium-escalation.jinja") },
      { name: "human-file-change.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-file-change.jinja") },
      { name: "human-infra-issues.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-infra-issues.jinja") },
      { name: "human-arm-stuck.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-arm-stuck.jinja") },
      { name: "human-arm-idle-loop.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-arm-idle-loop.jinja") },
      { name: "human-arm-zombie-killed.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-arm-zombie-killed.jinja") },
      { name: "human-task-blocked-by-bugs.jinja", source: join(process.cwd(), "src", "brain", "templates", "human-task-blocked-by-bugs.jinja") },
    ];

    for (const template of templates) {
      const destPath = join(templateDir, template.name);
      try {
        await readFile(destPath, "utf-8");
        // Template exists, skip
      } catch {
        // Template doesn't exist, try to create from source
        try {
          const sourceContent = await readFile(template.source, "utf-8");
          await mkdir(templateDir, { recursive: true });
          await writeFile(destPath, sourceContent, "utf-8");
          this.logger(`Created template: ${template.name}`);
        } catch (sourceErr) {
          this.logger(`Could not create template ${template.name}: ${sourceErr}`);
        }
      }
    }
  }
}
