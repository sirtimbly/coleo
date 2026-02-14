import { Command } from "commander";
import { getApiConfig, isApiRunning } from "../context";

interface ActivityListRow {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

interface ActivityApiResponse {
  activity?: unknown;
  message?: unknown;
}

interface TranscriptEntry {
  timestamp: string;
  armId: string;
  action: string;
  text: string;
  details: Record<string, unknown>;
  partitions: {
    armId: string;
    host: string | null;
    project: string | null;
    workdir: string | null;
  };
}

interface TranscriptApiResponse {
  transcript?: unknown;
  message?: unknown;
}

interface TranscriptQuery {
  limit: number;
  arm?: string;
  host?: string;
  project?: string;
  since?: string;
  until?: string;
  scanLimit?: number;
}

interface SearchResultRow {
  id: string;
  score: number;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface SearchApiResponse {
  results?: unknown;
  semanticUsed?: unknown;
  took?: unknown;
  error?: unknown;
}

export function registerActivityCommands(program: Command): void {
  const activityCmd = program.command("activity").description("View and search arm activity");

  activityCmd
    .command("list")
    .description("List recent activity entries")
    .option("-n, --count <n>", "Number of entries to show", "20")
    .option("-a, --actor <name>", "Filter by actor (arm or component name)")
    .action(async (options) => {
      const limit = parseLimit(options.count, 20, 200);
      const actor = asOptionalString(options.actor);

      const apiResult = await fetchActivityFromApi(limit, actor);
      if (!apiResult) {
        printApiUnavailable();
        return;
      }

      if (apiResult.rows.length === 0) {
        if (apiResult.message) {
          console.log(apiResult.message);
        }
        console.log("No activity recorded yet.");
        return;
      }

      printDetailedActivityRows(apiResult.rows);
    });

  activityCmd
    .command("transcript")
    .description("Show arm transcript events in oldest-first order")
    .option("-n, --count <n>", "Number of transcript events to show", "100")
    .option("--arm <ids>", "Filter by arm id(s), comma-separated")
    .option("--host <host>", "Filter by host")
    .option("--project <project>", "Filter by project")
    .option("--since <iso>", "Include events since ISO timestamp")
    .option("--until <iso>", "Include events until ISO timestamp")
    .option("--json", "Print raw JSON response")
    .action(async (options) => {
      const query: TranscriptQuery = {
        limit: parseLimit(options.count, 100, 1000),
        arm: asOptionalString(options.arm),
        host: asOptionalString(options.host),
        project: asOptionalString(options.project),
        since: asOptionalString(options.since),
        until: asOptionalString(options.until),
      };

      const result = await fetchTranscriptFromApi(query);
      if (!result) {
        printApiUnavailable();
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result.entries, null, 2));
        return;
      }

      if (result.entries.length === 0) {
        if (result.message) {
          console.log(result.message);
        }
        console.log("No transcript events found for the selected filters.");
        return;
      }

      printTranscriptEntries(result.entries);
    });

  activityCmd
    .command("tail")
    .description("Tail transcript events in near real-time (Ctrl+C to exit)")
    .option("-n, --count <n>", "Initial number of transcript events to show", "10")
    .option("--arm <ids>", "Filter by arm id(s), comma-separated")
    .option("--host <host>", "Filter by host")
    .option("--project <project>", "Filter by project")
    .option("--interval-ms <ms>", "Polling interval in milliseconds", "2000")
    .action(async (options) => {
      const pollIntervalMs = parseLimit(options.intervalMs, 2000, 30000);
      const baseQuery: TranscriptQuery = {
        limit: parseLimit(options.count, 10, 500),
        arm: asOptionalString(options.arm),
        host: asOptionalString(options.host),
        project: asOptionalString(options.project),
      };

      const initial = await fetchTranscriptFromApi(baseQuery);
      if (!initial) {
        printApiUnavailable();
        return;
      }

      console.log("Tailing transcript events (Ctrl+C to exit)...");
      console.log("=".repeat(80));

      if (initial.entries.length > 0) {
        printTranscriptEntries(initial.entries);
      }

      let lastTimestamp = initial.entries.length > 0
        ? initial.entries[initial.entries.length - 1]!.timestamp
        : new Date().toISOString();

      const seen = new Set<string>(initial.entries.map((entry) => transcriptSignature(entry)));

      const timer = setInterval(async () => {
        const next = await fetchTranscriptFromApi({
          ...baseQuery,
          limit: 200,
          scanLimit: 1000,
          since: lastTimestamp,
        });

        if (!next || next.entries.length === 0) {
          return;
        }

        let latestTimestamp = lastTimestamp;
        const toPrint: TranscriptEntry[] = [];

        for (const entry of next.entries) {
          const signature = transcriptSignature(entry);
          if (seen.has(signature)) {
            continue;
          }

          seen.add(signature);
          if (seen.size > 2000) {
            const oldest = seen.values().next().value;
            if (typeof oldest === "string") {
              seen.delete(oldest);
            }
          }

          toPrint.push(entry);
          if (entry.timestamp > latestTimestamp) {
            latestTimestamp = entry.timestamp;
          }
        }

        if (toPrint.length > 0) {
          printTranscriptEntries(toPrint);
        }

        lastTimestamp = latestTimestamp;
      }, pollIntervalMs);

      const stop = () => {
        clearInterval(timer);
        process.exit(0);
      };

      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      await new Promise(() => {});
    });

  activityCmd
    .command("search <query>")
    .description("Semantic search transcript events indexed in Qdrant")
    .option("-n, --count <n>", "Maximum results", "20")
    .option("--arm <ids>", "Filter by arm id(s), comma-separated")
    .option("--host <host>", "Filter by host")
    .option("--project <project>", "Filter by project")
    .option("--min-score <n>", "Minimum score threshold", "0.05")
    .action(async (query: string, options) => {
      const resultLimit = parseLimit(options.count, 20, 100);
      const minScore = parseNumber(options.minScore, 0.05);

      const filters: Record<string, unknown> = {};
      const arm = asOptionalString(options.arm);
      const host = asOptionalString(options.host);
      const project = asOptionalString(options.project);
      let armFilterSet: Set<string> | null = null;

      if (arm) {
        const armList = arm.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
        if (armList.length === 1) {
          filters.arm_id = armList[0];
        } else if (armList.length > 1) {
          armFilterSet = new Set(armList);
        }
      }
      if (host) {
        filters.host = host;
      }
      if (project) {
        filters.project = project;
      }

      const response = await fetchTranscriptSearch(query, {
        limit: resultLimit,
        minScore,
        filters,
      });

      if (!response) {
        printApiUnavailable();
        return;
      }

      if (response.results.length === 0) {
        console.log("No transcript search results found.");
        return;
      }

      const activeArmFilter = armFilterSet;
      const filteredResults = activeArmFilter
        ? response.results.filter((result) => {
            const armId = asDetailString(result.metadata.arm_id);
            return armId ? activeArmFilter.has(armId) : false;
          })
        : response.results;

      if (filteredResults.length === 0) {
        console.log("No transcript search results found.");
        return;
      }

      printSearchResults(filteredResults, response.semanticUsed, response.tookMs);
    });
}

async function fetchActivityFromApi(
  limit: number,
  actor?: string,
): Promise<{ rows: ActivityListRow[]; message?: string } | null> {
  if (!(await isApiRunning())) {
    return null;
  }

  const { apiUrl, headers } = getApiConfig();
  const query = new URLSearchParams({ limit: limit.toString() });
  if (actor) {
    query.set("actor", actor);
  }

  try {
    const response = await fetch(`${apiUrl}/api/activity?${query.toString()}`, { headers });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as ActivityApiResponse;
    const entries = Array.isArray(payload.activity) ? payload.activity : [];
    const rows = entries
      .map((entry, idx) => normalizeActivityRow(entry, idx + 1))
      .filter((entry): entry is ActivityListRow => entry !== null);

    return {
      rows,
      message: typeof payload.message === "string" ? payload.message : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchTranscriptFromApi(
  queryInput: TranscriptQuery,
): Promise<{ entries: TranscriptEntry[]; message?: string } | null> {
  if (!(await isApiRunning())) {
    return null;
  }

  const { apiUrl, headers } = getApiConfig();
  const query = new URLSearchParams({
    limit: queryInput.limit.toString(),
  });

  if (queryInput.arm) query.set("armId", queryInput.arm);
  if (queryInput.host) query.set("host", queryInput.host);
  if (queryInput.project) query.set("project", queryInput.project);
  if (queryInput.since) query.set("since", queryInput.since);
  if (queryInput.until) query.set("until", queryInput.until);
  if (typeof queryInput.scanLimit === "number") query.set("scanLimit", String(queryInput.scanLimit));

  try {
    const response = await fetch(`${apiUrl}/api/activity/transcript?${query.toString()}`, { headers });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as TranscriptApiResponse;
    const entries = Array.isArray(payload.transcript)
      ? payload.transcript
          .map(normalizeTranscriptEntry)
          .filter((entry): entry is TranscriptEntry => entry !== null)
      : [];

    return {
      entries,
      message: typeof payload.message === "string" ? payload.message : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchTranscriptSearch(
  query: string,
  options: {
    limit: number;
    minScore: number;
    filters: Record<string, unknown>;
  },
): Promise<{ results: SearchResultRow[]; semanticUsed: boolean; tookMs: number } | null> {
  if (!(await isApiRunning())) {
    return null;
  }

  const { apiUrl, headers } = getApiConfig();

  try {
    const response = await fetch(`${apiUrl}/api/search`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        types: ["arm_transcript"],
        limit: options.limit,
        minScore: options.minScore,
        keywordWeight: 0,
        semanticWeight: 1,
        filters: options.filters,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as SearchApiResponse;
    const rows = Array.isArray(payload.results)
      ? payload.results
          .map(normalizeSearchResult)
          .filter((entry): entry is SearchResultRow => entry !== null)
      : [];

    return {
      results: rows,
      semanticUsed: Boolean(payload.semanticUsed),
      tookMs: typeof payload.took === "number" ? payload.took : 0,
    };
  } catch {
    return null;
  }
}

function normalizeActivityRow(entry: unknown, fallbackId: number): ActivityListRow | null {
  if (!isRecord(entry)) {
    return null;
  }

  const id = typeof entry.id === "number" ? entry.id : fallbackId;
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
  const actor = typeof entry.actor === "string" ? entry.actor : "unknown";
  const action = typeof entry.action === "string" ? entry.action : "unknown";
  const target = typeof entry.target === "string" ? entry.target : null;

  return {
    id,
    timestamp,
    actor,
    action,
    target,
    details: normalizeDetails(entry.details),
  };
}

function normalizeTranscriptEntry(entry: unknown): TranscriptEntry | null {
  if (!isRecord(entry)) {
    return null;
  }

  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
  const armId = typeof entry.armId === "string" ? entry.armId : null;
  const action = typeof entry.action === "string" ? entry.action : "unknown";
  if (!timestamp || !armId) {
    return null;
  }

  const details = normalizeDetails(entry.details);
  const text = typeof entry.text === "string" && entry.text.length > 0
    ? entry.text
    : JSON.stringify(details);

  const partitionsRaw = isRecord(entry.partitions) ? entry.partitions : {};
  const partitions = {
    armId: typeof partitionsRaw.armId === "string" ? partitionsRaw.armId : armId,
    host: typeof partitionsRaw.host === "string" ? partitionsRaw.host : null,
    project: typeof partitionsRaw.project === "string" ? partitionsRaw.project : null,
    workdir: typeof partitionsRaw.workdir === "string" ? partitionsRaw.workdir : null,
  };

  return {
    timestamp,
    armId,
    action,
    text,
    details,
    partitions,
  };
}

function normalizeSearchResult(entry: unknown): SearchResultRow | null {
  if (!isRecord(entry)) {
    return null;
  }

  const id = typeof entry.id === "string" ? entry.id : null;
  const score = typeof entry.score === "number" ? entry.score : null;
  const title = typeof entry.title === "string" ? entry.title : "";
  const content = typeof entry.content === "string" ? entry.content : "";
  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString();

  if (!id || score === null) {
    return null;
  }

  return {
    id,
    score,
    title,
    content,
    metadata: normalizeDetails(entry.metadata),
    createdAt,
  };
}

function printDetailedActivityRows(rows: ActivityListRow[]): void {
  console.log("Activity Log");
  console.log("=".repeat(60));

  for (const row of rows) {
    const timestamp = new Date(row.timestamp).toLocaleString();
    const target = row.target ? ` on ${row.target}` : "";

    console.log(`[${timestamp}]`);
    console.log(`  ${row.actor} ${row.action}${target}`);

    const domain = asDetailString(row.details.domain);
    const status = asDetailString(row.details.status);
    const workdir = asDetailString(row.details.workdir);
    const pid = row.details.pid;

    if (domain) console.log(`    domain: ${domain}`);
    if (status) console.log(`    status: ${status}`);
    if (workdir) console.log(`    workdir: ${workdir}`);
    if (typeof pid === "number" || typeof pid === "string") console.log(`    pid: ${pid}`);

    if (
      Object.keys(row.details).length > 0 &&
      !domain &&
      !status &&
      !workdir &&
      pid === undefined
    ) {
      console.log(`    details: ${JSON.stringify(row.details)}`);
    }

    console.log("");
  }
}

function printTranscriptEntries(entries: TranscriptEntry[]): void {
  for (const entry of entries) {
    const timestamp = new Date(entry.timestamp).toLocaleString();
    const host = entry.partitions.host ? ` host=${entry.partitions.host}` : "";
    const project = entry.partitions.project ? ` project=${entry.partitions.project}` : "";

    console.log(`[${timestamp}] ${entry.armId} ${entry.action}${host}${project}`);
    console.log(`  ${truncate(entry.text, 220)}`);
    console.log("");
  }
}

function printSearchResults(results: SearchResultRow[], semanticUsed: boolean, tookMs: number): void {
  console.log(`Transcript search results (${results.length})${semanticUsed ? "" : " [keyword fallback]"} in ${tookMs}ms`);
  console.log("=".repeat(80));

  for (const result of results) {
    const armId = asDetailString(result.metadata.arm_id) || "unknown";
    const action = asDetailString(result.metadata.action) || result.title;
    const timestamp = asDetailString(result.metadata.timestamp) || result.createdAt;

    console.log(`[score=${result.score.toFixed(3)}] ${armId} ${action}`);
    console.log(`  ${new Date(timestamp).toLocaleString()}`);
    console.log(`  ${truncate(result.content, 240)}`);
    console.log("");
  }
}

function normalizeDetails(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDetailString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseLimit(rawValue: unknown, fallback: number, max: number): number {
  if (typeof rawValue !== "string") {
    return fallback;
  }

  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function parseNumber(rawValue: unknown, fallback: number): number {
  if (typeof rawValue !== "string") {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function transcriptSignature(entry: TranscriptEntry): string {
  return `${entry.timestamp}|${entry.armId}|${entry.action}|${entry.text}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function printApiUnavailable(): void {
  console.log("API server is not running.");
  console.log("Start it with: coleo serve");
}
