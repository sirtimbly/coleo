/** Numeric metadata versions; Release Please publishes canonical coleo-v tags. */
export function normalizeReleaseVersion(input: string): string {
  const version = input.replace(/^(?:coleo-v|v)/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
    throw new Error('Expected a numeric release version or coleo-vX.Y.Z tag');
  }
  return version;
}
