/** Harnesses currently tested and supported for user-created arms. */
export const SUPPORTED_HARNESSES = ["opencode-api"] as const;
export type SupportedHarness = (typeof SUPPORTED_HARNESSES)[number];

export function isSupportedHarness(value: unknown): value is SupportedHarness {
  return value === "opencode-api";
}

export class UnsupportedHarnessError extends Error {
  constructor() {
    super("Only the opencode-api harness is currently supported. Select opencode-api and try again.");
    this.name = "UnsupportedHarnessError";
  }
}

export function assertSupportedHarness(value: unknown): asserts value is SupportedHarness {
  if (!isSupportedHarness(value)) throw new UnsupportedHarnessError();
}
