import { Command } from "commander";
import { getApiConfig, isApiRunning } from "../context";
import {
  fetchActivityFromApi,
  fetchTranscriptFromApi,
  fetchTranscriptSearch,
  type TranscriptQuery,
  type TranscriptEntry,
} from "./activity-api";
import {
  parseLimit,
  parseNumber,
  asOptionalString,
  asDetailString,
} from "./activity-formatters";
import {
  printDetailedActivityRows,
  printTranscriptEntries,
  printSearchResults,
  transcriptSignature,
  printApiUnavailable,
} from "./activity-printers";

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

export { isApiRunning, getApiConfig };
