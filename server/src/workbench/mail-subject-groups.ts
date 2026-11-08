export const INFRASTRUCTURE_HEALTH_THREAD = "coleo:infrastructure-health";

/** Known repetitive system notices, independent of reply headers or arrival order. */
export function implicitMailThread(subject: string): string | undefined {
  return /infrastructure\s+health\s+issues\s+detected/i.test(subject) ? INFRASTRUCTURE_HEALTH_THREAD : undefined;
}
