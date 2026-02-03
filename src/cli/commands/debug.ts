import { Command } from "commander";
import { join } from "path";
import { getColeoDir } from "../context";

export function registerDebugCommands(program: Command): void {
  const debugCmd = program.command("debug").description("Debug and test brain components");

  debugCmd
    .command("intent <message>")
    .description("Test message intent processing (how the brain interprets a message)")
    .option("-s, --subject <subject>", "Message subject", "Test message")
    .option("-v, --verbose", "Show full LLM prompt and response")
    .option("--mock-arms <arms>", "Mock available arms (comma-separated name:status pairs)", "")
    .action(async (message: string, options: { subject: string; verbose?: boolean; mockArms: string }) => {
      const coleoDir = getColeoDir();
      const dbPath = join(coleoDir, "coleo.db");

      try {
        const { MailProcessor } = await import("../../brain/mail-processor");
        const { initDatabase } = await import("../../db");

        console.log("=".repeat(60));
        console.log("MESSAGE INTENT PROCESSING TEST");
        console.log("=".repeat(60));
        console.log();

        if (!process.env.OPENAI_API_KEY) {
          console.log("WARNING: OPENAI_API_KEY not set. Using fallback parsing.\n");
        } else {
          console.log(`Using model: ${process.env.OPENAI_MODEL || "gpt-4o-mini"}\n`);
        }

        let availableArms: Array<{ name: string; domain: string; status: string }> = [];
        let pendingTasks = 0;
        let recentActivity: string[] = [];

        try {
          const db = await initDatabase(dbPath);

          const arms = db
            .query(
              `
            SELECT name, domain, status FROM arms WHERE status != 'stopped' LIMIT 10
          `,
            )
            .all() as Array<{ name: string; domain: string; status: string }>;
          if (arms.length > 0) {
            availableArms = arms;
          }

          const taskCount = db
            .query(
              `
            SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'
          `,
            )
            .get() as { count: number };
          pendingTasks = taskCount?.count || 0;

          const activity = db
            .query(
              `
            SELECT actor, action FROM activity ORDER BY timestamp DESC LIMIT 5
          `,
            )
            .all() as Array<{ actor: string; action: string }>;
          recentActivity = activity.map((a) => `${a.actor} ${a.action}`);

          db.close();
        } catch {
          // Use defaults if DB not available
        }

        if (options.mockArms) {
          availableArms = options.mockArms.split(",").map((pair) => {
            const [name, status] = pair.split(":");
            return { name: name || "unknown", domain: "general", status: status || "idle" };
          });
        }

        console.log("Input:");
        console.log(`  Subject: ${options.subject}`);
        console.log(`  Body: ${message}`);
        console.log();

        console.log("Context:");
        console.log(
          `  Available arms: ${availableArms.map((a) => `${a.name}(${a.status})`).join(", ") || "none"}`,
        );
        console.log(`  Pending tasks: ${pendingTasks}`);
        console.log(`  Recent activity: ${recentActivity.slice(0, 3).join(", ") || "none"}`);
        console.log();

        const processor = new MailProcessor((msg) => {
          if (options.verbose) {
            console.log(`[DEBUG] ${msg}`);
          }
        });

        console.log("=".repeat(60));
        console.log("PROCESSING...");
        console.log("=".repeat(60));
        console.log();

        const startTime = Date.now();
        const intent = await processor.processMessage(options.subject, message, {
          availableArms,
          pendingTasks,
          recentActivity,
        });
        const elapsed = Date.now() - startTime;

        console.log(`Completed in ${elapsed}ms\n`);

        console.log("=".repeat(60));
        console.log("DETECTED INTENT");
        console.log("=".repeat(60));
        console.log();

        console.log(`Type: ${intent.type}`);
        console.log(`Reasoning: ${intent.reasoning || "N/A"}`);
        console.log();

        switch (intent.type) {
          case "new_task":
            console.log("Task Details:");
            console.log(`  Subject: ${intent.subject}`);
            console.log(
              `  Body: ${intent.body?.substring(0, 200)}${(intent.body?.length || 0) > 200 ? "..." : ""}`,
            );
            console.log(`  Priority: ${intent.priority || "normal"}`);
            console.log(`  Domain: ${intent.domain || "any"}`);
            break;

          case "prompt_arm":
            console.log("Arm Prompt:");
            console.log(`  Arm Name: ${intent.armName}`);
            console.log(`  Instruction: ${intent.instruction}`);
            break;

          case "doc_update":
            console.log("Doc Update:");
            console.log(`  Subject: ${intent.subject}`);
            console.log(`  Target Doc: ${intent.targetDoc || "unspecified"}`);
            break;

          case "approval_response":
            console.log("Approval Response:");
            console.log(`  Original ID: ${intent.originalId}`);
            console.log(`  Approved: ${intent.approved}`);
            console.log(`  Comment: ${intent.comment}`);
            break;

          case "query":
            console.log("Query:");
            console.log(`  Query Type: ${intent.query}`);
            break;

          case "escalate":
            console.log("Escalation:");
            console.log(`  Reason: ${intent.reasoning}`);
            break;
        }

        if (options.verbose) {
          console.log();
          console.log("=".repeat(60));
          console.log("RAW INTENT OBJECT");
          console.log("=".repeat(60));
          console.log(JSON.stringify(intent, null, 2));
        }
      } catch (err) {
        console.error("Error:", err);
        process.exit(1);
      }
    });

  debugCmd
    .command("intent-batch")
    .description("Test multiple messages for intent processing")
    .option("-v, --verbose", "Show detailed output for each message")
    .action(async (options: { verbose?: boolean }) => {
      const testMessages = [
        { subject: "Add dark mode", body: "Please add a dark mode toggle to the settings page" },
        { subject: "What's happening?", body: "Can you give me a status update on current work?" },
        { subject: "Re: [approval-123] Deploy changes?", body: "Yes, approved. Go ahead." },
        { subject: "Tell Xenix to stop", body: "Tell arm Xenix to stop what it's doing and focus on tests" },
        { subject: "Bug in login", body: "The login page is broken, users can't sign in" },
        { subject: "Update the README", body: "The README is out of date, please update it" },
        { subject: "asdfgh", body: "random gibberish that makes no sense 12345" },
      ];

      try {
        const { MailProcessor } = await import("../../brain/mail-processor");

        console.log("=".repeat(60));
        console.log("BATCH INTENT PROCESSING TEST");
        console.log("=".repeat(60));
        console.log();

        if (!process.env.OPENAI_API_KEY) {
          console.log("WARNING: OPENAI_API_KEY not set. Using fallback parsing.\n");
        }

        const processor = new MailProcessor((msg) => {
          if (options.verbose) {
            console.log(`[DEBUG] ${msg}`);
          }
        });

        const mockContext = {
          availableArms: [
            { name: "Xenix", domain: "backend", status: "busy" },
            { name: "Portia", domain: "frontend", status: "idle" },
          ],
          pendingTasks: 3,
          recentActivity: ["brain started", "arm spawned"],
        };

        console.log("Testing with mock context:");
        console.log(`  Arms: ${mockContext.availableArms.map((a) => `${a.name}(${a.status})`).join(", ")}`);
        console.log(`  Pending: ${mockContext.pendingTasks} tasks`);
        console.log();
        console.log("-".repeat(60));
        console.log();

        for (const msg of testMessages) {
          const startTime = Date.now();
          const intent = await processor.processMessage(msg.subject, msg.body, mockContext);
          const elapsed = Date.now() - startTime;

          console.log(`Subject: "${msg.subject}"`);
          console.log(`Body: "${msg.body.substring(0, 50)}${msg.body.length > 50 ? "..." : ""}"`);
          console.log(`  → Intent: ${intent.type} (${elapsed}ms)`);
          console.log(`  → Reasoning: ${intent.reasoning || "N/A"}`);

          if (options.verbose) {
            console.log(`  → Full: ${JSON.stringify(intent)}`);
          }

          console.log();
        }
      } catch (err) {
        console.error("Error:", err);
        process.exit(1);
      }
    });
}
