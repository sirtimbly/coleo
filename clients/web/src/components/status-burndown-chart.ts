export function niceAxisMaximum(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const roughStep = value / 5;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const niceStep = Math.max(1, (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude);
  return Math.ceil(value / niceStep) * niceStep;
}

export function stackedTotal(counts: Record<string, number>, statuses: readonly string[]): number {
  let total = 0;
  for (const status of statuses) total += counts[status] ?? 0;
  return total;
}
