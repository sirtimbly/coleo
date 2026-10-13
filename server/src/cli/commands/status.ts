import { Command } from "commander";
import { join } from "path";
import { readFile } from "fs/promises";
import { hostname } from "os";
import { getApiConfig, getColeoDir, isApiRunning } from "../context";
import { listArms } from "../../arm";
import { Maildir } from "../../mail";

interface ArmAgentDaemonStatus {
  id: string;
  pid: number | null;
  running: boolean;
  connected: boolean | null;
  error?: string;
}

function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function getArmAgentDaemonStatus(
  coleoDir: string,
  apiUrl: string,
  headers: Record<string, string>,
  apiRunning: boolean,
): Promise<ArmAgentDaemonStatus> {
  const defaultId = `agent-${hostname()}-autostart`;
  const status: ArmAgentDaemonStatus = {
    id: defaultId,
    pid: null,
    running: false,
    connected: null,
  };

  try {
    const raw = await readFile(join(coleoDir, "run", "agent-autostart.pid"), "utf-8");
    const parsed = JSON.parse(raw) as { pid?: unknown; id?: unknown };
    if (typeof parsed.id === "string" && parsed.id.trim().length > 0) {
      status.id = parsed.id;
    }
    if (typeof parsed.pid === "number") {
      status.pid = parsed.pid;
      status.running = isPidRunning(parsed.pid);
      if (!status.running) {
        status.error = "PID file is stale";
      }
    } else {
      status.error = "Missing PID in agent-autostart.pid";
    }
  } catch {
    status.error = "Not started";
  }

  if (!apiRunning) {
    return status;
  }

  try {
    const response = await fetch(`${apiUrl}/api/agents`, { headers });
    if (!response.ok) {
      return status;
    }

    const payload = (await response.json()) as {
      agents?: Array<{ agentId?: string; hostname?: string }>;
    };
    const agents = payload.agents || [];
    const connectedIds = new Set(
      agents
        .map((agent) => agent.agentId)
        .filter((agentId): agentId is string => typeof agentId === "string"),
    );
    const localAgents = agents.filter(
      (agent) => typeof agent.hostname === "string" && agent.hostname === hostname(),
    );

    status.connected = connectedIds.has(status.id) || localAgents.length > 0;
    if (localAgents.length > 0) {
      status.running = true;
      const localAgentId = localAgents[0]?.agentId;
      if (typeof localAgentId === "string" && localAgentId.trim().length > 0) {
        status.id = localAgentId;
      }
      if (!status.pid || !isPidRunning(status.pid)) {
        status.pid = null;
      }
      status.error = undefined;
    }
  } catch {
    status.connected = null;
  }

  return status;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show overall Coleo status")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const coleoDir = getColeoDir();
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
          qdrant?: { healthy: boolean; optional: boolean; error?: string };
          indexer?: { healthy: boolean; optional: boolean; running: boolean; error?: string };
        };
      };
      let enhancedStatus: EnhancedStatus | null = null;
      const apiRunning = await isApiRunning();

      if (apiRunning) {
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

      console.log(`Coleo Status`);
      console.log(`Directory: ${coleoDir}`);
      console.log(``);

      if (enhancedStatus) {
        console.log(`System: ${enhancedStatus.status} (v${enhancedStatus.version})`);
        const uptime = enhancedStatus.uptime;
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const armAgent = await getArmAgentDaemonStatus(coleoDir, apiUrl, headers, apiRunning);
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
        const qdrant = infra.qdrant ?? {
          healthy: false,
          optional: true,
          error: "Unavailable in /api/status (restart API server)",
        };
        console.log(
          `  Qdrant: ${qdrant.healthy ? "✓ Healthy" : "✗ " + (qdrant.error || "Unhealthy")}${qdrant.optional ? " (optional)" : ""}`,
        );
        if (infra.indexer) {
          console.log(
            `  Indexer: ${infra.indexer.running ? "✓ Running" : "○ Stopped"}${infra.indexer.optional ? " (optional)" : ""}${!infra.indexer.running && infra.indexer.error ? ` - ${infra.indexer.error}` : ""}`,
          );
        }
        console.log(
          `  ArmAgent: ${armAgent.running ? `✓ Running${armAgent.pid ? ` (PID ${armAgent.pid})` : ""}` : "○ Stopped"}${armAgent.connected === true ? " • connected" : armAgent.connected === false ? " • disconnected" : ""}${!armAgent.running && armAgent.error ? ` - ${armAgent.error}` : ""}`,
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
        if (apiRunning) {
          console.log(`API Server: running`);
        } else {
          console.log(`API Server: not running`);
        }

        const armAgent = await getArmAgentDaemonStatus(coleoDir, apiUrl, headers, apiRunning);
        console.log(
          `ArmAgent: ${armAgent.running ? `running${armAgent.pid ? ` (PID ${armAgent.pid})` : ""}` : "stopped"}${armAgent.connected === true ? " • connected" : armAgent.connected === false ? " • disconnected" : ""}${!armAgent.running && armAgent.error ? ` (${armAgent.error})` : ""}`,
        );

        try {
          const content = await readFile(join(coleoDir, "state", "brain.json"), "utf-8");
          const state = JSON.parse(content);
          console.log(`Brain: ${state.status} (last poll: ${state.lastPollAt || "never"})`);
        } catch {
          console.log(`Brain: not started`);
        }

        const arms = await listArms(coleoDir);
        const activeArms = arms.filter((a) => a.status !== "stopped");
        const stoppedArms = arms.filter((a) => a.status === "stopped");
        console.log(`Arms: ${activeArms.length} active, ${stoppedArms.length} stopped`);
        for (const a of activeArms) {
          console.log(`  - ${a.id}: ${a.status}`);
        }

        const inbox = new Maildir(join(coleoDir, "mail", "inbox"));
        const newCount = await inbox.count("new");
        console.log(`Inbox: ${newCount} unread`);

        try {
          const content = await readFile(join(coleoDir, "state", "tasks.json"), "utf-8");
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
