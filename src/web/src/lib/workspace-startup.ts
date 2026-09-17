export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

export const WORKSPACE_STARTUP_TIMEOUT_MS = 180_000;

export function isWorkspaceStarting(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name))
    || (error instanceof ApiRequestError &&
      (error.code === 'WORKSPACE_STARTING' || [502, 504].includes(error.status)));
}
