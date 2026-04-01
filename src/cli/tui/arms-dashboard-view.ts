import type {
  DashboardActivityEntry,
  DashboardArmDetail,
  DashboardArmMessage,
  DashboardArmSummary,
  DashboardDiscovery,
  DashboardSnapshot,
  DashboardStatusReport,
} from "./arms-dashboard-data";

export type DashboardNodeKind =
  | "brain"
  | "arms-root"
  | "arm"
  | "status-reports"
  | "discoveries"
  | "activity"
  | "api"
  | "nats"
  | "mail";

export interface DashboardNode {
  id: string;
  kind: DashboardNodeKind;
  label: string;
  description: string;
  depth: number;
  armId?: string;
}

export interface DashboardView {
  title: string;
  subtitle: string;
  lines: string[];
}

function formatDateTime(value?: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatAge(value?: string | null): string {
  if (!value) return "n/a";
  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "n/a";
  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s ago`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ago`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatUptime(seconds?: number): string {
  if (!seconds || seconds < 0) return "n/a";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function pushSection(lines: string[], title: string, rows: string[]): void {
  lines.push(title);
  lines.push("-".repeat(title.length));
  lines.push(...rows);
  lines.push("");
}

function flattenMessageParts(message: DashboardArmMessage): string[] {
  const lines: string[] = [];

  for (const part of message.parts) {
    if (part.type === "text" && part.text?.trim()) {
      lines.push(...part.text.trim().split(/\r?\n/).map((line) => `  ${line}`));
      continue;
    }

    if ((part.type === "tool-invocation" || part.type === "tool") && (part.toolName || part.name)) {
      const toolName = part.toolName || part.name || "unknown";
      const state = part.state || part.status || "completed";
      lines.push(`  [tool] ${toolName} (${state})`);
    }
  }

  if (lines.length === 0) {
    lines.push("  (no visible content)");
  }

  return lines;
}

function formatArmMessages(messages: DashboardArmMessage[]): string[] {
  const lines: string[] = [];

  for (const message of messages) {
    const role = message.info.role || "unknown";
    lines.push(`${role.toUpperCase()}  ${message.info.id}`);
    lines.push(...flattenMessageParts(message));
    lines.push("");
  }

  return lines.length > 0 ? lines : ["(no messages yet)"];
}

function formatActivityRows(entries: DashboardActivityEntry[]): string[] {
  if (entries.length === 0) {
    return ["(no recent activity)"];
  }

  return entries.map((entry) => {
    const details = Object.entries(entry.details || {})
      .slice(0, 3)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");

    return [
      formatDateTime(entry.timestamp),
      entry.actor || "unknown",
      entry.action,
      details,
    ].filter((part) => part.length > 0).join("  ");
  });
}

function formatDiscoveryRows(discoveries: DashboardDiscovery[]): string[] {
  if (discoveries.length === 0) {
    return ["(no discoveries)"];
  }

  const rows: string[] = [];
  for (const discovery of discoveries) {
    rows.push(
      `[${discovery.severity}] ${discovery.title}  ${discovery.armName || discovery.armId}  ${formatAge(discovery.createdAt)}`,
    );
    if (discovery.filePath) {
      rows.push(`  file: ${discovery.filePath}${discovery.lineNumber ? `:${discovery.lineNumber}` : ""}`);
    }
    rows.push(`  ${discovery.details}`);
    rows.push("");
  }

  return rows;
}

function formatStatusReportRows(reports: DashboardStatusReport[]): string[] {
  if (reports.length === 0) {
    return ["(no status reports)"];
  }

  const rows: string[] = [];
  for (const report of reports) {
    rows.push(
      `[${report.status}] ${report.armId} -> ${report.taskId}  ${formatAge(report.createdAt)}`,
    );
    rows.push(`  ${report.summary}`);
    if (report.nextSteps) {
      rows.push(`  next: ${report.nextSteps}`);
    }
    rows.push("");
  }
  return rows;
}

function formatMailRows(snapshot: DashboardSnapshot): string[] {
  if (snapshot.inboxMessages.length === 0) {
    return ["Inbox is empty."];
  }

  return snapshot.inboxMessages.map((message) => {
    const unread = message.flags.seen ? " " : "*";
    return `${unread} ${formatDateTime(message.date.toISOString())}  ${message.from}  ${message.subject}`;
  });
}

function buildArmRow(arm: DashboardArmSummary): string {
  const runtimeState = arm.runtime?.state || "unknown";
  const task = arm.currentTaskSubject || arm.currentBugTitle || "(unassigned)";
  return [
    arm.name || arm.id,
    `[${arm.status}]`,
    runtimeState,
    `task=${task}`,
    `activity=${formatAge(arm.lastActivityAt || arm.runtime?.lastActivityAt)}`,
  ].join("  ");
}

export function buildDashboardNodes(snapshot: DashboardSnapshot): DashboardNode[] {
  const activeArms = snapshot.arms
    .filter((arm) => arm.status !== "stopped")
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  const nodes: DashboardNode[] = [
    {
      id: "brain",
      kind: "brain",
      label: "Brain",
      description: snapshot.brainService.running ? "service and logs" : "stopped",
      depth: 0,
    },
    {
      id: "arms",
      kind: "arms-root",
      label: `Arms (${activeArms.length})`,
      description: "active arm sessions",
      depth: 0,
    },
  ];

  for (const arm of activeArms) {
    nodes.push({
      id: `arm:${arm.id}`,
      kind: "arm",
      label: arm.name || arm.id,
      description: `${arm.status} ${arm.currentTaskSubject || arm.currentBugTitle || ""}`.trim(),
      depth: 1,
      armId: arm.id,
    });
  }

  nodes.push(
    {
      id: "status-reports",
      kind: "status-reports",
      label: `Status Reports (${snapshot.statusReports.length})`,
      description: "recent arm updates",
      depth: 0,
    },
    {
      id: "discoveries",
      kind: "discoveries",
      label: `Discoveries (${snapshot.discoveries.length})`,
      description: "recent findings",
      depth: 0,
    },
    {
      id: "activity",
      kind: "activity",
      label: `Activity (${snapshot.recentActivity.length})`,
      description: "recent system events",
      depth: 0,
    },
    {
      id: "api",
      kind: "api",
      label: "API",
      description: snapshot.serverService.running ? "server service" : "stopped",
      depth: 0,
    },
    {
      id: "nats",
      kind: "nats",
      label: "NATS",
      description: "event stream health",
      depth: 0,
    },
    {
      id: "mail",
      kind: "mail",
      label: `Mail (${snapshot.inboxMessages.filter((msg) => !msg.flags.seen).length})`,
      description: "human/brain messages",
      depth: 0,
    },
  );

  return nodes;
}

export function buildViewForNode(
  snapshot: DashboardSnapshot,
  node: DashboardNode,
  armDetail: DashboardArmDetail | null,
): DashboardView {
  switch (node.kind) {
    case "brain": {
      const lines: string[] = [];
      pushSection(lines, "Overview", [
        `service: ${snapshot.brainService.running ? "running" : "stopped"}`,
        `pid: ${snapshot.brainService.pid || "n/a"}`,
        `uptime: ${formatUptime(snapshot.brainService.uptime)}`,
        `brain state: ${snapshot.brainState?.status || "unknown"}`,
        `last poll: ${formatDateTime(snapshot.brainState?.lastPollAt)}`,
        `poll interval: ${snapshot.brainState?.pollIntervalMs || "n/a"}ms`,
        `pending tasks: ${snapshot.brainState?.pendingTasks ?? "n/a"}`,
        `completed today: ${snapshot.brainState?.completedToday ?? "n/a"}`,
      ]);
      pushSection(lines, "Brain Log", snapshot.brainLogLines.length > 0 ? snapshot.brainLogLines : ["(no persisted brain log yet)"]);

      return {
        title: "Brain",
        subtitle: "Service state and persisted brain log",
        lines,
      };
    }
    case "arms-root": {
      const activeArms = snapshot.arms.filter((arm) => arm.status !== "stopped");
      const lines: string[] = [];
      pushSection(lines, "Summary", [
        `api available: ${snapshot.apiAvailable ? "yes" : "no"}`,
        `active arms: ${activeArms.length}`,
        `total known arms: ${snapshot.arms.length}`,
      ]);
      pushSection(lines, "Active Arms", activeArms.length > 0 ? activeArms.map(buildArmRow) : ["(no active arms)"]);

      return {
        title: "Arms",
        subtitle: "Live arm status overview",
        lines,
      };
    }
    case "arm": {
      const arm = armDetail?.arm || snapshot.arms.find((candidate) => candidate.id === node.armId) || null;
      const lines: string[] = [];

      if (!arm) {
        lines.push("Arm details are unavailable.");
        return {
          title: node.label,
          subtitle: "Arm detail view",
          lines,
        };
      }

      pushSection(lines, "Overview", [
        `status: ${arm.status}`,
        `runtime: ${arm.runtime?.state || "unknown"}`,
        `reason: ${arm.runtime?.reason || "n/a"}`,
        `task: ${arm.currentTaskSubject || "(none)"}`,
        `bug: ${arm.currentBugTitle || "(none)"}`,
        `provider/model: ${arm.provider ? `${arm.provider}/${arm.model || "default"}` : arm.model || "default"}`,
        `workdir: ${arm.workdir || "n/a"}`,
        `host: ${arm.host || "local"}`,
        `session: ${arm.sessionId || "n/a"}`,
        `last activity: ${formatDateTime(arm.lastActivityAt || arm.runtime?.lastActivityAt)}`,
        `last heartbeat: ${formatDateTime(arm.lastHeartbeat || arm.runtime?.lastHeartbeatAt)}`,
        `last output: ${formatDateTime(arm.lastOutputAt || arm.runtime?.lastOutputAt)}`,
      ]);

      pushSection(lines, "Recent Messages", armDetail?.messagesError
        ? [`message fetch error: ${armDetail.messagesError}`]
        : formatArmMessages(armDetail?.messages || []));
      pushSection(lines, "Recent Activity", armDetail?.activityMessage
        ? [`activity message: ${armDetail.activityMessage}`]
        : formatActivityRows(armDetail?.activity || []));

      return {
        title: arm.name || arm.id,
        subtitle: "Arm detail, messages, and activity",
        lines,
      };
    }
    case "status-reports":
      return {
        title: "Status Reports",
        subtitle: "Recent status updates from arms",
        lines: formatStatusReportRows(snapshot.statusReports),
      };
    case "discoveries":
      return {
        title: "Discoveries",
        subtitle: "Recent findings and issues",
        lines: formatDiscoveryRows(snapshot.discoveries),
      };
    case "activity":
      return {
        title: "Activity",
        subtitle: "Recent system and arm events",
        lines: formatActivityRows(snapshot.recentActivity),
      };
    case "api": {
      const lines: string[] = [];
      pushSection(lines, "Overview", [
        `service: ${snapshot.serverService.running ? "running" : "stopped"}`,
        `pid: ${snapshot.serverService.pid || "n/a"}`,
        `uptime: ${formatUptime(snapshot.serverService.uptime)}`,
        `api reachable: ${snapshot.apiAvailable ? "yes" : "no"}`,
        `started: ${formatDateTime(snapshot.systemStatus?.startedAt)}`,
      ]);
      if (snapshot.systemStatus?.infrastructure) {
        pushSection(lines, "Infrastructure", [
          `database: ${snapshot.systemStatus.infrastructure.database?.healthy ? "healthy" : snapshot.systemStatus.infrastructure.database?.error || "unhealthy"}`,
          `nats: ${snapshot.systemStatus.infrastructure.nats?.healthy ? "healthy" : snapshot.systemStatus.infrastructure.nats?.error || "unhealthy"}`,
          `maildir: ${snapshot.systemStatus.infrastructure.maildir?.healthy ? "healthy" : snapshot.systemStatus.infrastructure.maildir?.error || "unhealthy"}`,
          `qdrant: ${snapshot.systemStatus.infrastructure.qdrant?.healthy ? "healthy" : snapshot.systemStatus.infrastructure.qdrant?.error || "unhealthy"}`,
        ]);
      }
      pushSection(lines, "API Log", snapshot.serverLogLines.length > 0 ? snapshot.serverLogLines : ["(no server log yet)"]);

      return {
        title: "API",
        subtitle: "API service status and daemon log",
        lines,
      };
    }
    case "nats": {
      const lines: string[] = [];
      pushSection(lines, "Overview", [
        `nats health: ${snapshot.systemStatus?.infrastructure?.nats?.healthy ? "healthy" : snapshot.systemStatus?.infrastructure?.nats?.error || "unknown"}`,
        `indexer service: ${snapshot.indexerService.running ? "running" : "stopped"}`,
        `indexer uptime: ${formatUptime(snapshot.indexerService.uptime)}`,
      ]);
      if (snapshot.indexerHealth) {
        pushSection(lines, "Indexer Health", [
          `status: ${snapshot.indexerHealth.status}`,
          `stream: ${snapshot.indexerHealth.stream}`,
          `durable: ${snapshot.indexerHealth.durable}`,
          `consumer found: ${snapshot.indexerHealth.consumerFound ? "yes" : "no"}`,
          `lag messages: ${snapshot.indexerHealth.lagMessages ?? "n/a"}`,
          `ack pending: ${snapshot.indexerHealth.ackPending ?? "n/a"}`,
          `last active: ${formatDateTime(snapshot.indexerHealth.lastActive)}`,
          `updated: ${formatDateTime(snapshot.indexerHealth.updatedAt)}`,
          snapshot.indexerHealth.message ? `message: ${snapshot.indexerHealth.message}` : "message: n/a",
        ]);
      } else {
        pushSection(lines, "Indexer Health", ["(indexer health unavailable)"]);
      }

      return {
        title: "NATS",
        subtitle: "JetStream and transcript indexer health",
        lines,
      };
    }
    case "mail":
      return {
        title: "Mail",
        subtitle: "Recent inbox messages",
        lines: formatMailRows(snapshot),
      };
  }
}

export function applySearch(lines: string[], query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return lines;
  }

  const lower = trimmed.toLowerCase();
  const matched = lines.filter((line) => line.toLowerCase().includes(lower));

  if (matched.length === 0) {
    return [`No matches for "${trimmed}".`];
  }

  return [
    `Search: ${trimmed} (${matched.length} match${matched.length === 1 ? "" : "es"})`,
    "",
    ...matched,
  ];
}

export function buildFooterControls(
  node: DashboardNode,
  interruptBeforeSend: boolean,
): string {
  const shared = "tab focus  j/k move  r refresh  / search  e editor  q quit";

  if (node.kind === "brain") {
    return `${shared}  |  m message brain  R restart brain`;
  }

  if (node.kind === "arms-root") {
    return `${shared}  |  n spawn arm`;
  }

  if (node.kind === "arm") {
    return `${shared}  |  m message arm  i interrupt=${interruptBeforeSend ? "on" : "off"}  s mark stuck  x kill  d delete  n spawn arm`;
  }

  return shared;
}

