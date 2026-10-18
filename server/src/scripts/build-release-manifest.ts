import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { normalizeReleaseVersion } from './component-release-version';

export interface ArtifactInput {
  file: string;
  format: 'tar.gz' | 'zip' | 'wheel';
  entry?: string;
}

export interface ComponentInput {
  version: string;
  runtime?: 'bun' | 'uv';
  dependencies?: 'client'[];
  python?: string;
  wheel?: string;
  signed?: boolean;
  notarized?: boolean;
  compatibility: { testedServer: string; requiredCapabilities: string[] };
  artifacts: Record<string, ArtifactInput>;
}

export interface ReleaseArtifact extends ArtifactInput {
  url: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  commit: string;
  components: Record<string, Omit<ComponentInput, 'artifacts'> & {
    artifacts: Record<string, Omit<ReleaseArtifact, 'file'>>;
  }>;
}

const versionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const platforms = new Set(['any', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']);

/** Build only from local, already-tested release assets; never resolves latest or downloads. */
export async function buildReleaseManifest(options: {
  version: string; commit: string; assets: string; repository?: string;
}): Promise<ReleaseManifest> {
  const { commit, assets, repository = 'sirtimbly/coleo' } = options;
  const version = normalizeReleaseVersion(options.version);
  if (!versionPattern.test(version) || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('Release requires a version and full git commit');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const manifest: ReleaseManifest = { schemaVersion: 1, version, commit, components: {} };
  const files = (await readdir(assets)).filter(name => name.endsWith('.component.json')).sort();
  if (!files.length) throw new Error('No component descriptors found');
  for (const file of files) {
    const descriptor = JSON.parse(await readFile(join(assets, file), 'utf8')) as Record<string, ComponentInput>;
    for (const [name, component] of Object.entries(descriptor)) {
      if (!['operator', 'client', 'web', 'macos', 'bun', 'uv'].includes(name)) {
        throw new Error(`Unknown distribution: ${name}`);
      }
      if (!component || !versionPattern.test(component.version)
        || component.compatibility?.testedServer !== version
        || !Array.isArray(component.compatibility.requiredCapabilities)) {
        throw new Error(`Invalid version/compatibility metadata for ${name}`);
      }
      if (name === 'operator' && component.runtime !== 'bun') throw new Error('Operator requires Bun');
      if (name === 'web' && (component.runtime !== 'bun' || component.dependencies?.length !== 1
        || component.dependencies[0] !== 'client')) throw new Error('Web requires Bun and client');
      if (name === 'client' && (component.runtime !== 'uv'
        || !/^3\.\d+\.\d+$/.test(component.python ?? '')
        || !/^coleo_inbox-[\w.]+-py3-none-any\.whl$/.test(component.wheel ?? ''))) {
        throw new Error('Client requires uv, pinned Python, and a coleo-inbox wheel');
      }
      if (name === 'macos' && (!component.signed || !component.notarized)) {
        throw new Error('macOS publication requires signing and notarization evidence');
      }
      const { artifacts, ...metadata } = component;
      const existing = manifest.components[name];
      if (existing) {
        const { artifacts: ignored, ...previous } = existing;
        void ignored;
        if (JSON.stringify(previous) !== JSON.stringify(metadata)) throw new Error(`Conflicting metadata: ${name}`);
      } else manifest.components[name] = { ...metadata, artifacts: {} };
      if (!artifacts || !Object.keys(artifacts).length) throw new Error(`No artifacts for ${name}`);
      for (const [platform, artifact] of Object.entries(artifacts)) {
        if (!platforms.has(platform) || (name === 'macos' && !platform.startsWith('darwin-'))) {
          throw new Error(`Unsupported platform: ${platform}`);
        }
        if (manifest.components[name]!.artifacts[platform]) throw new Error(`Duplicate ${name}/${platform}`);
        if (basename(artifact.file) !== artifact.file || !/^[\w.-]+$/.test(artifact.file)
          || !['tar.gz', 'zip', 'wheel'].includes(artifact.format)) throw new Error('Unsafe artifact filename/format');
        if (artifact.entry && (artifact.entry.startsWith('/') || artifact.entry.split('/').includes('..')
          || artifact.entry.includes('\\'))) throw new Error('Unsafe runtime entry');
        if (['bun', 'uv'].includes(name) && !artifact.entry) throw new Error('Runtime entry required');
        const path = join(assets, artifact.file);
        const size = (await stat(path)).size;
        if (!size) throw new Error(`Empty artifact: ${artifact.file}`);
        const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
        manifest.components[name]!.artifacts[platform] = {
          url: `https://github.com/${repository}/releases/download/coleo-v${version}/${artifact.file}`,
          sha256, size, format: artifact.format, ...(artifact.entry ? { entry: artifact.entry } : {}),
        };
      }
    }
  }
  for (const component of Object.values(manifest.components)) {
    if (!component.runtime) continue;
    const targets = Object.keys(component.artifacts).includes('any')
      ? [...platforms].filter(platform => platform !== 'any') : Object.keys(component.artifacts);
    for (const platform of targets) {
      if (!manifest.components[component.runtime]?.artifacts[platform]) {
        throw new Error(`Missing ${component.runtime} runtime for ${platform}`);
      }
      for (const dependency of component.dependencies ?? []) {
        if (!manifest.components[dependency]?.artifacts[platform]) {
          throw new Error(`Missing ${dependency} dependency for ${platform}`);
        }
      }
    }
  }
  return manifest;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string): string => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
    return args[index + 1]!;
  };
  const assets = option('--assets');
  const manifest = await buildReleaseManifest({
    version: option('--version'), commit: option('--commit'), assets,
  });
  await writeFile(join(assets, 'coleo-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums: string[] = [];
  for (const name of (await readdir(assets)).sort()) {
    if (name === 'SHA256SUMS' || name.endsWith('.component.json')) continue;
    const path = join(assets, name);
    if (!(await stat(path)).isFile()) continue;
    sums.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${name}`);
  }
  await writeFile(join(assets, 'SHA256SUMS'), `${sums.join('\n')}\n`);
}
