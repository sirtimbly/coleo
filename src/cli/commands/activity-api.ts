import { getApiConfig, isApiRunning } from "../context";
import type {
  ActivityApiResponse,
  ActivityListRow,
  SearchApiResponse,
  SearchResultRow,
  TranscriptApiResponse,
  TranscriptEntry,
  TranscriptQuery,
} from "./activity-types";
import { normalizeActivityRow, normalizeTranscriptEntry, normalizeSearchResult } from "./activity-formatters";

export type {
  ActivityListRow,
  ActivityApiResponse,
  TranscriptEntry,
  TranscriptApiResponse,
  TranscriptQuery,
  SearchResultRow,
  SearchApiResponse,
} from "./activity-types";

export async function fetchActivityFromApi(
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

export async function fetchTranscriptFromApi(
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

export async function fetchTranscriptSearch(
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
