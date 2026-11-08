/** Bounded parallel work with stable output order. Drain in-flight requests on
 * failure before releasing the job's lock; do not keep scheduling queued work.
 */
export async function mapCatchupWork<T, R>(items: readonly T[], concurrency: number,
  operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Catch-up concurrency must be between 1 and 8");
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await operation(items[index]!, index); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
  return results;
}
