import { readFile } from "fs/promises";
import { join } from "path";
import {
  getLogFilePath,
  getServiceLogs,
  getServiceStatus,
  restartService,
  type ServiceStatus,
} from "../../daemon";
import { Maildir, type MailMessage } from "../../mail";
import { getApiConfig, getColeoDir, isApiRunning } from "../context";

export interface DashboardArmRuntime {
  state: string;
  reason: string;
  distributed: boolean;
  hasRuntime: boolean;
  hasSession: boolean;
  canRecover: boolean;
  canRestart: boolean;
  lastActivityAt: string | null;
  lastHeartbeatAt: string | null;
  lastOutputAt: string | null;
  secondsSinceActivity: number | null;
  secondsSinceHeartbeat: number | null;
  secondsSinceOutput: number | null;
  signals: {
    dbStatus: string;
    hasPid: boolean;
    hasPort: boolean;
    hasSessionId: boolean;
    hasAgentId: boolean;
    hasWorkdir: boolean;
    hasAssignedTask: boolean;
    distributed: boolean;
  };
}

export interface DashboardArmSummary {
  id: string;
  name: string;
  domain?: string;
  harness?: string;
  status: string;
  provider?: string;
  model?: string;
  pid?: number;
  port?: number;
  currentTaskId?: string;
  currentTaskSubject?: string;
  currentBugId?: string;
  currentBugTitle?: string;
  agentId?: string;
  host?: string;
  sessionId?: string;
  workdir?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string | null;
  lastHeartbeat?: string | null;
  lastOutputAt?: string | null;
  totalTokens?: number;
  totalCost?: number;
  runtime?: DashboardArmRuntime;
}

export interface DashboardBrainState {
  status?: string;
  pollIntervalMs?: number;
  startedAt?: string;
  lastPollAt?: string;
  activeArms?: unknown[];
  pendingTasks?: number;
  completedToday?: number;
}

export interface DashboardSystemStatus {
  status?: string;
  startedAt?: string;
  uptime?: number;
  counts?: {
    arms?: number;
    proposals?: number;
    activity?: number;
  };
  arms?: Array<{
    id: string;
    name: string;
    status: string;
    health: string;
    currentTask?: string;
    lastActivity?: string;
    lastHeartbeat?: string;
  }>;
  infrastructure?: {
    database?: { healthy: boolean; error?: string };
    nats?: { healthy: boolean; optional: boolean; error?: string };
    maildir?: { healthy: boolean; error?: string };
    qdrant?: { healthy: boolean; optional: boolean; error?: string };
    indexer?: { healthy: boolean; optional: boolean; running: boolean; error?: string };
  };
}

export interface DashboardIndexerHealth {
  status: string;
  stream: string;
  durable: string;
  consumerFound: boolean;
  lagMessages: number | null;
  ackPending: number | null;
  streamLastSeq: number | null;
  consumerStreamSeq: number | null;
  consumerSeq: number | null;
  lastActive: string | null;
  staleThresholdMs: number;
  updatedAt: string;
  message?: string;
}

export interface DashboardActivityEntry {
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

export interface DashboardDiscovery {
  id: string;
  armId: string;
  armName: string;
  kind: string;
  title: string;
  details: string;
  filePath?: string;
  lineNumber?: number;
  severity: string;
  status: string;
  taskId?: string;
  phase?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardStatusReport {
  id: string;
  taskId: string;
  armId: string;
  status: string;
  summary: string;
  issues?: string[];
  blockers?: string[];
  nextSteps?: string;
  filesChanged?: string[];
  testsStatus?: string;
  createdAt: string;
}

export interface DashboardArmMessage {
  info: {
    role: string;
    id: string;
  };
  parts: Array<{
    type: string;
    text?: string;
    toolName?: string;
    name?: string;
    state?: string;
    status?: string;
  }>;
}

export interface DashboardArmDetail {
  arm: DashboardArmSummary | null;
  messages: DashboardArmMessage[];
  messagesError?: string;
  sessionId?: string;
  activity: DashboardActivityEntry[];
  activityMessage?: string;
}

export interface DashboardSnapshot {
  refreshedAt: string;
  apiAvailable: boolean;
  arms: DashboardArmSummary[];
  brainService: ServiceStatus;
  serverService: ServiceStatus;
  indexerService: ServiceStatus;
  brainState: DashboardBrainState | null;
  systemStatus: DashboardSystemStatus | null;
  indexerHealth: DashboardIndexerHealth | null;
  recentActivity: DashboardActivityEntry[];
  discoveries: DashboardDiscovery[];
  statusReports: DashboardStatusReport[];
  inboxMessages: MailMessage[];
  sentMessages: MailMessage[];
  brainLogLines: string[];
  serverLogLines: string[];
}

const RECENT_LOG_LINES = 160;
const RECENT_MAIL_COUNT = 20;

function tailLines(input: string, count: number): string[] {
  if (!input.trim()) {
    return [];
  }

  const lines = input.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length <= count) {
    return lines;
  }
  return lines.slice(-count);
}

async function readTailLines(path: string, count: number): Promise<string[]> {
  try {
    const content = await readFile(path, "utf-8");
    return tailLines(content, count);
  } catch {
    return [];
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readMailboxMessages(folder: "inbox" | "sent", limit: number): Promise<MailMessage[]> {
  const coleoDir = getColeoDir();
  const mailbox = new Maildir(join(coleoDir, "mail", folder));

  try {
    const [fresh, seen] = await Promise.all([
      mailbox.list("new"),
      mailbox.list("cur"),
    ]);

    return [...fresh, ...seen]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  const { apiUrl, headers } = getApiConfig();

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init?.headers || {}),
      },
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiUrl, headers } = getApiConfig();

  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers || {}),
    },
  });

  const text = await response.text();
  let data: unknown = null;

  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    if (data && typeof data === "object" && "error" in data) {
      throw new Error(String((data as { error?: unknown }).error || response.statusText));
    }
    throw new Error(typeof data === "string" && data.length > 0 ? data : response.statusText);
  }

  return data as T;
}

export async function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  const coleoDir = getColeoDir();
  const brainLogPath = join(coleoDir, "logs", "brain.log");
  const apiAvailable = await isApiRunning();

  const [
    brainService,
    serverService,
    indexerService,
    brainState,
    brainLogLines,
    serverLogLines,
    inboxMessages,
    sentMessages,
  ] = await Promise.all([
    getServiceStatus("brain"),
    getServiceStatus("server"),
    getServiceStatus("indexer"),
    readJsonFile<DashboardBrainState>(join(coleoDir, "state", "brain.json")),
    readTailLines(brainLogPath, RECENT_LOG_LINES),
    getServiceLogs("server", RECENT_LOG_LINES).catch(() => [] as string[]),
    readMailboxMessages("inbox", RECENT_MAIL_COUNT),
    readMailboxMessages("sent", RECENT_MAIL_COUNT),
  ]);

  let arms: DashboardArmSummary[] = [];
  let systemStatus: DashboardSystemStatus | null = null;
  let recentActivity: DashboardActivityEntry[] = [];
  let discoveries: DashboardDiscovery[] = [];
  let statusReports: DashboardStatusReport[] = [];
  let indexerHealth: DashboardIndexerHealth | null = null;

  if (apiAvailable) {
    const [
      armsResponse,
      systemStatusResponse,
      activityResponse,
      discoveriesResponse,
      statusReportsResponse,
      indexerHealthResponse,
    ] = await Promise.all([
      fetchJson<{ arms: DashboardArmSummary[] }>("/api/arms?includeAll=true"),
      fetchJson<DashboardSystemStatus>("/api/status"),
      fetchJson<{ activity: DashboardActivityEntry[] }>("/api/activity?limit=60"),
      fetchJson<{ discoveries: DashboardDiscovery[] }>("/api/discoveries?limit=30"),
      fetchJson<{ reports: DashboardStatusReport[] }>("/api/status-reports?limit=30"),
      fetchJson<DashboardIndexerHealth>("/api/activity/indexer-health"),
    ]);

    arms = armsResponse?.arms || [];
    systemStatus = systemStatusResponse;
    recentActivity = activityResponse?.activity || [];
    discoveries = discoveriesResponse?.discoveries || [];
    statusReports = statusReportsResponse?.reports || [];
    indexerHealth = indexerHealthResponse;
  }

  return {
    refreshedAt: new Date().toISOString(),
    apiAvailable,
    arms,
    brainService,
    serverService,
    indexerService,
    brainState,
    systemStatus,
    indexerHealth,
    recentActivity,
    discoveries,
    statusReports,
    inboxMessages,
    sentMessages,
    brainLogLines,
    serverLogLines,
  };
}

export async function fetchArmDetail(armId: string): Promise<DashboardArmDetail | null> {
  if (!(await isApiRunning())) {
    return null;
  }

  const [armResponse, messagesResponse, activityResponse] = await Promise.all([
    fetchJson<{ arm: DashboardArmSummary }>(`/api/arms/${encodeURIComponent(armId)}`),
    fetchJson<{
      messages: DashboardArmMessage[];
      sessionId?: string;
      error?: string;
    }>(`/api/arms/${encodeURIComponent(armId)}/messages?limit=30`),
    fetchJson<{
      activity: DashboardActivityEntry[];
      message?: string;
    }>(`/api/arms/${encodeURIComponent(armId)}/activity?limit=20`),
  ]);

  return {
    arm: armResponse?.arm || null,
    messages: messagesResponse?.messages || [],
    messagesError: messagesResponse?.error,
    sessionId: messagesResponse?.sessionId,
    activity: activityResponse?.activity || [],
    activityMessage: activityResponse?.message,
  };
}

export async function sendArmMessage(
  armId: string,
  message: string,
  interrupt: boolean,
): Promise<void> {
  await apiRequest(
    `/api/arms/${encodeURIComponent(armId)}/prompt`,
    {
      method: "POST",
      body: JSON.stringify({ prompt: message, interrupt }),
    },
  );
}

export async function sendBrainMessage(message: string): Promise<void> {
  await apiRequest("/api/brain/message", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export async function markArmStuck(armId: string): Promise<void> {
  await apiRequest(
    `/api/arms/${encodeURIComponent(armId)}/mark-stuck`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function killArmSession(armId: string): Promise<void> {
  await apiRequest(
    `/api/arms/${encodeURIComponent(armId)}/kill`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function deleteArmProfile(armId: string): Promise<void> {
  await apiRequest(
    `/api/arms/${encodeURIComponent(armId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function restartBrainService(): Promise<ServiceStatus> {
  return restartService("brain");
}

export async function readFullBrainLogLines(): Promise<string[]> {
  return readTailLines(join(getColeoDir(), "logs", "brain.log"), Number.MAX_SAFE_INTEGER);
}

export async function readFullServerLogLines(): Promise<string[]> {
  return readTailLines(getLogFilePath("server"), Number.MAX_SAFE_INTEGER);
}
