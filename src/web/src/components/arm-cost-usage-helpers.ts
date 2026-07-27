import type { JsonValue } from '@/lib';

export const COST_WINDOW_MS = 30 * 60 * 1000;
export const COST_POLL_INTERVAL_MS = 12_000;
export const COST_RATE_WINDOW_MS = 5 * 60 * 1000;
export const STORAGE_PREFIX = 'coleo-arm-cost-';
export const MAX_STORED_SAMPLES = 240;

export interface CostSample {
  timestamp: number;
  cumulativeCost: number;
  messageCost: number;
  inputTokens: number;
  outputTokens: number;
}

export function getStorageKey(armId: string): string {
  return `${STORAGE_PREFIX}${armId}`;
}

export function parseMessageTimestamp(timeValue: JsonValue | undefined): number | null {
  if (timeValue === undefined || timeValue === null) {
    return null;
  }
  let raw: JsonValue = timeValue;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, JsonValue>;
    raw = obj.completed ?? obj.created ?? obj.updated ?? obj.end ?? obj.start ?? null;
  }
  let date: Date | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw;
    date = new Date(ms);
  } else if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) {
      const parsed = Number.parseInt(raw, 10);
      const ms = parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
      date = new Date(ms);
    } else {
      date = new Date(raw);
    }
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

export function appendCostSample(prev: CostSample[], sample: CostSample): CostSample[] {
  const cutoff = Date.now() - COST_WINDOW_MS;
  const trimmed = prev.filter((s) => s.timestamp >= cutoff);
  if (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1]!;
    if (
      Math.abs(last.timestamp - sample.timestamp) < 100 &&
      last.cumulativeCost === sample.cumulativeCost &&
      last.messageCost === sample.messageCost
    ) {
      return trimmed;
    }
  }
  return [...trimmed, sample].slice(-MAX_STORED_SAMPLES);
}

export function buildCostSamplesFromMessages(
  messages: Array<{
    info: {
      id: string;
      cost?: number;
      tokens?: { input?: number; output?: number };
      time?: JsonValue;
    };
  }>,
): CostSample[] {
  const parsed: Array<CostSample & { messageId: string }> = [];
  for (const message of messages) {
    const ts = parseMessageTimestamp(message.info.time);
    const cost = typeof message.info.cost === 'number' ? message.info.cost : 0;
    if (ts === null || cost <= 0) continue;
    parsed.push({
      messageId: message.info.id,
      timestamp: ts,
      messageCost: cost,
      cumulativeCost: 0,
      inputTokens: message.info.tokens?.input ?? 0,
      outputTokens: message.info.tokens?.output ?? 0,
    });
  }

  parsed.sort((a, b) => a.timestamp - b.timestamp);
  let running = 0;
  return parsed.map((sample) => {
    running += sample.messageCost;
    return {
      timestamp: sample.timestamp,
      cumulativeCost: running,
      messageCost: sample.messageCost,
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
    };
  });
}

export function computeCostRatePerHour(samples: CostSample[], referenceTime = Date.now()): number {
  if (samples.length < 2) return 0;
  const cutoff = referenceTime - COST_RATE_WINDOW_MS;
  const qualifyingSamples = samples.filter((s) => s.timestamp >= cutoff);
  if (qualifyingSamples.length < 2) return 0;
  const first = qualifyingSamples[0]!;
  const last = qualifyingSamples[qualifyingSamples.length - 1]!;
  const elapsedMs = last.timestamp - first.timestamp;
  if (elapsedMs <= 0) return 0;
  const costDelta = last.cumulativeCost - first.cumulativeCost;
  if (costDelta <= 0) return 0;
  return costDelta / (elapsedMs / 3_600_000);
}
