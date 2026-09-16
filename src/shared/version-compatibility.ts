/** Wire schema changes independently of product releases; bump only for breaking payload changes. */
export const NATS_SCHEMA_VERSION = 1;

export interface RuntimeVersion {
  version?: string;
  natsSchemaVersion?: number;
}

export interface FleetVersions {
  api: RuntimeVersion;
  agents: Array<RuntimeVersion & { agentId: string; hostname: string }>;
  agentDiscoveryAvailable: boolean;
}

export type VersionCompatibility = 'synced' | 'drift' | 'incompatible' | 'unknown';

// SemVer 2.0, including prerelease and build metadata. No coercion of malformed reports.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function isReleaseVersion(version: string): boolean {
  return SEMVER.test(version);
}

export function compareRuntimeVersions(expected: RuntimeVersion, actual: RuntimeVersion): VersionCompatibility {
  const left = typeof expected.version === 'string' ? SEMVER.exec(expected.version) : null;
  const right = typeof actual.version === 'string' ? SEMVER.exec(actual.version) : null;
  const validSchema = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (validSchema(expected.natsSchemaVersion) && validSchema(actual.natsSchemaVersion)
    && expected.natsSchemaVersion !== actual.natsSchemaVersion) return 'incompatible';
  if (left && right && (left[1] !== right[1] || (left[1] === '0' && left[2] !== right[2]))) {
    return 'incompatible';
  }
  if (!left || !right || !validSchema(expected.natsSchemaVersion) || !validSchema(actual.natsSchemaVersion)) {
    return 'unknown';
  }
  if (expected.version === actual.version) return 'synced';
  // Prereleases make no compatibility promise with other builds.
  if (left[4] || right[4]) return 'incompatible';
  return 'drift';
}
