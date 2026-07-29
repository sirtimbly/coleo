import { describe, expect, it } from 'bun:test';

import {
  aggregateContextSamples,
  mapAllArmCostSamples,
} from '../src/components/all-arms-telemetry';

describe('all-arm telemetry helpers', () => {
  it('aggregates each arm latest context reading over time', () => {
    const samples = aggregateContextSamples([
      { armId: 'arm-a', timestamp: '2026-07-28T10:00:00.000Z', used: 100, budget: 1000 },
      { armId: 'arm-b', timestamp: '2026-07-28T10:00:00.000Z', used: 200, budget: 2000 },
      { armId: 'arm-a', timestamp: '2026-07-28T10:01:00.000Z', used: 400, budget: 500 },
    ]);

    expect(samples).toEqual([
      { timestamp: new Date('2026-07-28T10:00:00.000Z').getTime(), used: 300, budget: 3000 },
      { timestamp: new Date('2026-07-28T10:01:00.000Z').getTime(), used: 600, budget: 2500 },
    ]);
  });

  it('keeps per-arm message IDs and token telemetry distinct', () => {
    const samples = mapAllArmCostSamples([
      {
        armId: 'arm-a',
        timestamp: '2026-07-28T10:00:00.000Z',
        cost: 0.2,
        messageId: 'message-1',
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 30,
        cacheReadTokens: 40,
        cacheWriteTokens: 50,
      },
      {
        armId: 'arm-b',
        timestamp: '2026-07-28T10:01:00.000Z',
        cost: 0.3,
        messageId: 'message-1',
        inputTokens: 60,
        outputTokens: 70,
        reasoningTokens: 80,
        cacheReadTokens: 90,
        cacheWriteTokens: 100,
      },
    ]);

    expect(samples.map((sample) => sample.messageId)).toEqual(['arm-a:message-1', 'arm-b:message-1']);
    expect(samples[1]).toMatchObject({ inputTokens: 60, outputTokens: 70, reasoningTokens: 80 });
  });

  it('retains token telemetry when the provider reports zero cost', () => {
    const samples = mapAllArmCostSamples([{
      armId: 'arm-a',
      timestamp: '2026-07-28T10:00:00.000Z',
      cost: 0,
      messageId: 'message-1',
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
    }]);

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ messageCost: 0, inputTokens: 100, outputTokens: 20 });
  });
});
