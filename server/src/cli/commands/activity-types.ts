export interface ActivityListRow {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

export interface ActivityApiResponse {
  activity?: unknown;
  message?: unknown;
}

export interface TranscriptEntry {
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

export interface TranscriptApiResponse {
  transcript?: unknown;
  message?: unknown;
}

export interface TranscriptQuery {
  limit: number;
  arm?: string;
  host?: string;
  project?: string;
  since?: string;
  until?: string;
  scanLimit?: number;
}

export interface SearchResultRow {
  id: string;
  score: number;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SearchApiResponse {
  results?: unknown;
  semanticUsed?: unknown;
  took?: unknown;
  error?: unknown;
}
