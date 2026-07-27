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

export function cumulativeCostAt(samples: CostSample[], index: number): number {
  let total = 0;
  for (let i = 0; i <= index; i++) {
    total += samples[i]!.messageCost;
  }
  return total;
}

export function withCumulativeCost(samples: CostSample[]): Array<CostSample & { cumulativeCost: number }> {
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
  freshBuild: Array<Omit<CostSample, 'cumulativeCost'>>,
): CostSample[] {
  const byMessage = new Map<string, CostSample>();
  for (const sample of stored) byMessage.set(sample.messageId, sample);
  for (const sample of freshBuild) byMessage.set(sample.messageId, sample);
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

export function computeCostRatePerHour(
  samples: Array<CostSample & { cumulativeCost?: number }>,
  referenceTime = Date.now(),
): number {
  if (samples.length < 2) return 0;
  const cutoff = referenceTime - COST_RATE_WINDOW_MS;
  const qualifyingIndexes: number[] = [];
  samples.forEach((sample, index) => {
    if (sample.timestamp >= cutoff) qualifyingIndexes.push(index);
  });
  if (qualifyingIndexes.length < 2) return 0;
  const firstIndex = qualifyingIndexes[0]!;
  const lastIndex = qualifyingIndexes[qualifyingIndexes.length - 1]!;
  let firstCumulative = samples[firstIndex]!.cumulativeCost;
  if (firstCumulative === undefined) firstCumulative = cumulativeCostAt(samples, firstIndex);
  let lastCumulative = samples[lastIndex]!.cumulativeCost;
  if (lastCumulative === undefined) lastCumulative = cumulativeCostAt(samples, lastIndex);
  const elapsedMs = samples[lastIndex]!.timestamp - samples[firstIndex]!.timestamp;
  if (elapsedMs <= 0) return 0;
  const costDelta = lastCumulative - firstCumulative;
  if (costDelta <= 0) return 0;
  return costDelta / (elapsedMs / 3_600_000);
}
