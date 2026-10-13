import { describe, expect, it } from 'bun:test';
import { compareRuntimeVersions, isReleaseVersion } from '../../shared/version-compatibility';

const runtime = (version: string, natsSchemaVersion = 1) => ({ version, natsSchemaVersion });

describe('distributed version compatibility', () => {
  it.each([
    ['1.2.3', '1.2.3', 'synced'],
    ['1.2.3', '1.9.0', 'drift'],
    ['1.2.3', '2.2.3', 'incompatible'],
    ['0.12.1', '0.12.2', 'drift'],
    ['0.12.1', '0.13.0', 'incompatible'],
    ['1.2.3-rc.1', '1.2.3-rc.1', 'synced'],
    ['1.2.3-rc.1', '1.2.3', 'incompatible'],
    ['1.2.3+abc', '1.2.3+def', 'drift'],
    ['1.2.3', 'invalid', 'unknown'],
  ] as const)('%s versus %s is %s', (left, right, expected) => {
    expect(compareRuntimeVersions(runtime(left), runtime(right))).toBe(expected);
  });

  it('never labels missing or invalid schema reports as compatible', () => {
    expect(compareRuntimeVersions(runtime('1.2.3'), { version: '1.2.3' })).toBe('unknown');
    expect(compareRuntimeVersions(runtime('1.2.3'), runtime('1.2.3', 0))).toBe('unknown');
    expect(compareRuntimeVersions(runtime('1.2.3'), runtime('1.2.3', 2))).toBe('incompatible');
    expect(compareRuntimeVersions(runtime('1.2.3'), {})).toBe('unknown');
  });

  it.each(['01.2.3', '1.2', 'v1.2.3', '1.2.3-01', '1.2.3-', '1.2.3+'])('rejects malformed SemVer %s', (version) => {
    expect(isReleaseVersion(version)).toBe(false);
  });
});
