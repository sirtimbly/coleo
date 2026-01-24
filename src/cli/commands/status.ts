import { Command } from "commander";
import { join } from "path";
import { readFile } from "fs/promises";
import { getApiConfig, getOctopaiDir, isApiRunning } from "../context";
import { listArms } from "../../arm";
import { Maildir } from "../../mail";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show overall Octopai status")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const octopaiDir = getOctopaiDir();
      const { apiUrl, headers } = getApiConfig();

      type EnhancedStatus = {
        status: string;
        version: string;
        uptime: number;
        arms: {
          total: number;
          healthy: number;
          idle: number;
          stuck: number;
          stale: number;
          details?: Array<{
            id: string;
            name: string;
            status: string;
            domain: string;
            currentTask?: string;
            lastHeartbeat?: string;
            health: string;
          }>;
        };
        proposals: { open: number };
        activity: { last24h: number };
        infrastructure: {
          database: { healthy: boolean; error?: string };
          nats: { healthy: boolean; optional: boolean; error?: string };
          maildir: { healthy: boolean; error?: string };
        };
      };
      let enhancedStatus: EnhancedStatus | null = null;

      if (await isApiRunning()) {
        try {
          const res = await fetch(`${apiUrl}/api/status`, { headers });
          if (res.ok) {
            enhancedStatus = (await res.json()) as EnhancedStatus;
          }
        } catch {
          // Fall back to manual checks
        }
      }

      if (options.json) {
        if (enhancedStatus) {
          console.log(JSON.stringify(enhancedStatus, null, 2));
        } else {
          console.log(JSON.stringify({ error: "API not available" }, null, 2));
        }
        return;
      }

      console.log(`Octopai Status`);
      console.log(`Directory: ${octopaiDir}`);
      console.log(``);

      if (enhancedStatus) {
        console.log(`System: ${enhancedStatus.status} (v${enhancedStatus.version})`);
        const uptime = enhancedStatus.uptime;
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        console.log(`Uptime: ${hours}h ${minutes}m`);
        console.log(``);

        console.log(`Infrastructure:`);
        const infra = enhancedStatus.infrastructure;
        console.log(
          `  Database: ${infra.database.healthy ? "✓ Healthy" : "✗ " + (infra.database.error || "Unhealthy")}`,
        );
        console.log(
          `  NATS: ${infra.nats.healthy ? "✓ Healthy" : "✗ " + (infra.nats.error || "Unhealthy")}${infra.nats.optional ? " (optional)" : ""}`,
        );
        console.log(
          `  Maildir: ${infra.maildir.healthy ? "✓ Healthy" : "✗ " + (infra.maildir.error || "Unhealthy")}`,
        );
        console.log(``);

        const arms = enhancedStatus.arms;
        console.log(`Arms: ${arms.total} total`);
        if (arms.total > 0) {
          console.log(`  Health: ${arms.healthy} healthy, ${arms.idle} idle, ${arms.stuck} stuck, ${arms.stale} stale`);
          if (arms.details && arms.details.length > 0) {
            console.log(`\n  Details:`);
            for (const arm of arms.details) {
              const healthIcon =
                arm.health === "healthy"
                  ? "✓"
                  : arm.health === "idle"
                    ? "○"
                    : arm.health === "stuck"
                      ? "✗"
                      : "△";
              console.log(`    ${healthIcon} ${arm.name} (${arm.domain})`);
              console.log(`      Status: ${arm.status} | Health: ${arm.health}`);
              if (arm.currentTask) {
                console.log(`      Task: ${arm.currentTask}`);
              }
              if (arm.lastHeartbeat) {
                const hbAge = Math.floor((Date.now() - new Date(arm.lastHeartbeat).getTime()) / 1000);
                console.log(`      Last heartbeat: ${hbAge}s ago`);
              }
            }
          }
        }
        console.log(``);

        console.log(`Proposals: ${enhancedStatus.proposals.open} open`);
        console.log(`Activity: ${enhancedStatus.activity.last24h} events (24h)`);
      } else {
        if (await isApiRunning()) {
          console.log(`API Server: running`);
        } else {
          console.log(`API Server: not running`);
        }

        try {
          const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
          const state = JSON.parse(content);
          console.log(`Brain: ${state.status} (last poll: ${state.lastPollAt || "never"})`);
        } catch {
          console.log(`Brain: not started`);
        }

        const arms = await listArms(octopaiDir);
        const activeArms = arms.filter((a) => a.status !== "stopped");
        const stoppedArms = arms.filter((a) => a.status === "stopped");
        console.log(`Arms: ${activeArms.length} active, ${stoppedArms.length} stopped`);
        for (const a of activeArms) {
          console.log(`  - ${a.id}: ${a.status}`);
        }

        const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));
        const newCount = await inbox.count("new");
        console.log(`Inbox: ${newCount} unread`);

        try {
          const content = await readFile(join(octopaiDir, "state", "tasks.json"), "utf-8");
          const tasks = JSON.parse(content);
          const pending = tasks.filter((t: { status: string }) => t.status === "pending").length;
          const inProgress = tasks.filter((t: { status: string }) => t.status === "in_progress").length;
          console.log(`Tasks: ${pending} pending, ${inProgress} in progress`);
        } catch {
          console.log(`Tasks: 0`);
        }
      }
    });
}
