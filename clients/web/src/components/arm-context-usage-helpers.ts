/**
 * Shared constants and helpers for the Arm Context Usage chart.
 *
 * Kept in a separate module so unit tests can import the constants without
 * needing the @/lib (api) bundle, which is bundler-resolved and not
 * available to bun test outside the Vite runtime.
 */

export const SAMPLE_WINDOW_MS = 30 * 60 * 1000;
export const SAMPLE_INTERVAL_MS = 12_000;
export const COMPRESSION_THRESHOLD_PCT = 0.8;
export const STORAGE_PREFIX = 'coleo-arm-context-';
export const MAX_STORED_SAMPLES = 240;

export interface ContextSample {
  timestamp: number;
  used: number;
  budget: number;
}

export function appendSample(prev: ContextSample[], sample: ContextSample): ContextSample[] {
  const cutoff = Date.now() - SAMPLE_WINDOW_MS;
  const trimmed = prev.filter((s) => s.timestamp >= cutoff);
  if (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1]!;
    if (
      Math.abs(last.timestamp - sample.timestamp) < 100 &&
      last.used === sample.used &&
      last.budget === sample.budget
    ) {
      return trimmed;
    }
  }
  const merged = [...trimmed, sample];
  return merged.slice(-MAX_STORED_SAMPLES);
}
