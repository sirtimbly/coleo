import type { ContextSample } from './arm-context-usage-helpers';
import type { CostSample } from './arm-cost-usage-helpers';

interface RawContextSample {
  armId: string;
  timestamp: string;
  used: number;
  budget: number;
}

interface RawCostSample {
  armId: string;
  timestamp: string;
  cost: number;
  messageId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function aggregateContextSamples(
  samples: RawContextSample[],
): ContextSample[] {
  const sorted = samples
    .map((sample) => ({ ...sample, timestampMs: new Date(sample.timestamp).getTime() }))
    .filter((sample) => Number.isFinite(sample.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const latestByArm = new Map<string, { used: number; budget: number }>();
  const aggregate: ContextSample[] = [];

  for (let index = 0; index < sorted.length;) {
    const timestamp = sorted[index]!.timestampMs;
    while (index < sorted.length && sorted[index]!.timestampMs === timestamp) {
      const sample = sorted[index]!;
      latestByArm.set(sample.armId, { used: sample.used, budget: sample.budget });
      index += 1;
    }

    let used = 0;
    let budget = 0;
    for (const sample of latestByArm.values()) {
      used += sample.used;
      budget += sample.budget;
    }
    aggregate.push({ timestamp, used, budget });
  }

  return aggregate;
}

export function mapAllArmCostSamples(
  samples: RawCostSample[],
): CostSample[] {
  return samples
    .map((sample) => ({
      messageId: `${sample.armId}:${sample.messageId}`,
      timestamp: new Date(sample.timestamp).getTime(),
      messageCost: sample.cost,
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      reasoningTokens: sample.reasoningTokens,
      cacheReadTokens: sample.cacheReadTokens,
      cacheWriteTokens: sample.cacheWriteTokens,
    }))
    .filter((sample) => Number.isFinite(sample.timestamp) && sample.messageCost >= 0)
    .sort((left, right) => left.timestamp - right.timestamp);
}
