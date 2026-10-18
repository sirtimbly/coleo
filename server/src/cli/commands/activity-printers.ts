import type { ActivityListRow, TranscriptEntry, SearchResultRow } from "./activity-types";
import { asDetailString } from "./activity-formatters";

export function printDetailedActivityRows(rows: ActivityListRow[]): void {
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

export function printTranscriptEntries(entries: TranscriptEntry[]): void {
  for (const entry of entries) {
    const timestamp = new Date(entry.timestamp).toLocaleString();
    const host = entry.partitions.host ? ` host=${entry.partitions.host}` : "";
    const project = entry.partitions.project ? ` project=${entry.partitions.project}` : "";

    console.log(`[${timestamp}] ${entry.armId} ${entry.action}${host}${project}`);
    console.log(`  ${truncate(entry.text, 220)}`);
    console.log("");
  }
}

export function printSearchResults(results: SearchResultRow[], semanticUsed: boolean, tookMs: number): void {
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

export function transcriptSignature(entry: TranscriptEntry): string {
  return `${entry.timestamp}|${entry.armId}|${entry.action}|${entry.text}`;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

export function printApiUnavailable(): void {
  console.log("API server is not running.");
  console.log("Start it with: coleo serve");
}
