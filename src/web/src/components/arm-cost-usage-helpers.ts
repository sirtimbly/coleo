import type { JsonValue } from '@/lib';

export const COST_WINDOW_MS = 30 * 60 * 1000;
export const COST_POLL_INTERVAL_MS = 12_000;
export const COST_RATE_WINDOW_MS = 5 * 60 * 1000;
export const STORAGE_PREFIX = 'coleo-arm-cost-';
export const MAX_STORED_SAMPLES = 240;

export interface CostSample {
  timestamp: number;
  messageCost: number;
  inputTokens: number;
  outputTokens: number;
  messageId: string;
}

export function withCumulativeCost(samples: CostSample[]): CumulativeCostSample[] {
  let running = 0;
  return samples
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((sample) => {
      running += sample.messageCost;
      return { ...sample, cumulativeCost: running };
    });
}

export function mergeCostSamples(
  stored: CostSample[],
  fresh: CostSample[],
): CostSample[] {
  const byMessage = new Map<string, CostSample>();
  for (const sample of stored) byMessage.set(sample.messageId, sample);
  for (const sample of fresh) byMessage.set(sample.messageId, sample);
  return Array.from(byMessage.values());
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
  const parsed: CostSample[] = [];
  for (const message of messages) {
    const ts = parseMessageTimestamp(message.info.time);
    const cost = typeof message.info.cost === 'number' ? message.info.cost : 0;
    if (ts === null || cost <= 0) continue;
    parsed.push({
      messageId: message.info.id,
      timestamp: ts,
      messageCost: cost,
      inputTokens: message.info.tokens?.input ?? 0,
      outputTokens: message.info.tokens?.output ?? 0,
    });
  }
  return parsed;
}

export interface CumulativeCostSample extends CostSample {
  cumulativeCost: number;
}

export function computeCostRatePerHour(
  samples: CumulativeCostSample[],
  referenceTime = Date.now(),
): number {
  if (samples.length < 2) return 0;
  const cutoff = referenceTime - COST_RATE_WINDOW_MS;
  const qualifying: CumulativeCostSample[] = [];
  for (const sample of samples) {
    if (sample.timestamp >= cutoff) qualifying.push(sample);
  }
  if (qualifying.length < 2) return 0;
  const first = qualifying[0]!;
  const last = qualifying[qualifying.length - 1]!;
  const elapsedMs = last.timestamp - first.timestamp;
  if (elapsedMs <= 0) return 0;
  const costDelta = last.cumulativeCost - first.cumulativeCost;
  if (costDelta <= 0) return 0;
  return costDelta / (elapsedMs / 3_600_000);
}
