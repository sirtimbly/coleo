import { expect, test } from 'bun:test';
import { ApiRequestError, isWorkspaceStarting } from '../src/lib/workspace-startup';

test('retries startup and transport failures, while preserving real errors', () => {
  expect(isWorkspaceStarting(new ApiRequestError('connecting', 503, 'WORKSPACE_STARTING'))).toBe(true);
  expect(isWorkspaceStarting(new ApiRequestError('gateway unavailable', 502))).toBe(true);
  expect(isWorkspaceStarting(new TypeError('Failed to fetch'))).toBe(true);
  expect(isWorkspaceStarting(new DOMException('Timed out', 'TimeoutError'))).toBe(true);
  for (const status of [400, 401, 403, 500, 503]) {
    expect(isWorkspaceStarting(new ApiRequestError('configuration problem', status))).toBe(false);
  }
});
