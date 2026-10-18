import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildReleaseManifest } from '../build-release-manifest';
import { normalizeReleaseVersion } from '../component-release-version';

async function webDependencies(assets: string): Promise<void> {
  const compatibility = { testedServer: '1.2.3', requiredCapabilities: [] };
  const artifacts = Object.fromEntries(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
    .map(platform => [platform, { file: 'web.tar.gz', format: 'tar.gz', entry: 'runtime' }]));
  await writeFile(join(assets, 'runtime.component.json'), JSON.stringify({
    bun: { version: '1.2.3', compatibility, artifacts },
    uv: { version: '1.2.3', compatibility, artifacts },
    client: { version: '1.2.3', compatibility, artifacts, runtime: 'uv', python: '3.12.12',
      wheel: 'coleo_inbox-1.2.3-py3-none-any.whl' },
  }));
}

describe('component release manifest', () => {
  test.each(['1.2.3', 'v1.2.3', 'coleo-v1.2.3'])('normalizes %s and pins canonical URLs/checksums', async version => {
    const assets = await mkdtemp(join(tmpdir(), 'coleo-manifest-'));
    try {
      await writeFile(join(assets, 'web.tar.gz'), 'fixture');
      await webDependencies(assets);
      await writeFile(join(assets, 'web.component.json'), JSON.stringify({ web: {
        version: '1.2.3', runtime: 'bun', dependencies: ['client'], compatibility: { testedServer: '1.2.3', requiredCapabilities: [] },
        artifacts: { any: { file: 'web.tar.gz', format: 'tar.gz' } },
      } }));
      const manifest = await buildReleaseManifest({ assets, version, commit: 'a'.repeat(40) });
      expect(manifest.version).toBe('1.2.3');
      expect(manifest.components.web!.artifacts.any).toEqual({
        url: 'https://github.com/sirtimbly/coleo/releases/download/coleo-v1.2.3/web.tar.gz',
        sha256: 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d', size: 7, format: 'tar.gz',
      });
    } finally { await rm(assets, { recursive: true, force: true }); }
  });
  test('published-event tag works through the builder CLI', async () => {
    const assets = await mkdtemp(join(tmpdir(), 'coleo-manifest-cli-'));
    try {
      await writeFile(join(assets, 'web.tar.gz'), 'fixture');
      await webDependencies(assets);
      await writeFile(join(assets, 'web.component.json'), JSON.stringify({ web: {
        version: '1.2.3', runtime: 'bun', dependencies: ['client'], compatibility: { testedServer: '1.2.3', requiredCapabilities: [] },
        artifacts: { any: { file: 'web.tar.gz', format: 'tar.gz' } },
      } }));
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../build-release-manifest.ts'),
        '--assets', assets, '--version', 'coleo-v1.2.3', '--commit', 'a'.repeat(40)],
      { stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).toBe(0);
      const manifest = JSON.parse(await readFile(join(assets, 'coleo-release.json'), 'utf8'));
      expect(manifest.version).toBe('1.2.3');
      expect(manifest.components.web.artifacts.any.url)
        .toBe('https://github.com/sirtimbly/coleo/releases/download/coleo-v1.2.3/web.tar.gz');
      expect(await readFile(join(assets, 'SHA256SUMS'), 'utf8')).toContain('  coleo-release.json\n');
    } finally { await rm(assets, { recursive: true, force: true }); }
  });
  test('shared packager normalization rejects malformed release inputs', () => {
    expect(normalizeReleaseVersion('coleo-v1.2.3')).toBe('1.2.3');
    for (const input of ['', 'latest', 'coleo-vv1.2.3', 'coleo-v1.2.3/other']) {
      expect(() => normalizeReleaseVersion(input)).toThrow();
    }
  });
  test('web any bundle requires platform Bun and client dependencies', async () => {
    const assets = await mkdtemp(join(tmpdir(), 'coleo-web-manifest-'));
    try {
      await writeFile(join(assets, 'web.tar.gz'), 'fixture');
      await webDependencies(assets);
      const web = { version: '1.2.3', runtime: 'bun', dependencies: ['client'],
        compatibility: { testedServer: '1.2.3', requiredCapabilities: [] },
        artifacts: { any: { file: 'web.tar.gz', format: 'tar.gz' } } };
      await writeFile(join(assets, 'web.component.json'), JSON.stringify({ web }));
      const path = join(assets, 'runtime.component.json');
      const dependencies = JSON.parse(await readFile(path, 'utf8'));
      delete dependencies.client.artifacts['linux-arm64'];
      await writeFile(path, JSON.stringify(dependencies));
      await expect(buildReleaseManifest({ assets, version: '1.2.3', commit: 'a'.repeat(40) }))
        .rejects.toThrow('Missing client dependency for linux-arm64');
      await webDependencies(assets);
      const missingRuntime = JSON.parse(await readFile(path, 'utf8'));
      delete missingRuntime.bun.artifacts['darwin-x64'];
      await writeFile(path, JSON.stringify(missingRuntime));
      await expect(buildReleaseManifest({ assets, version: '1.2.3', commit: 'a'.repeat(40) }))
        .rejects.toThrow('Missing bun runtime for darwin-x64');
    } finally { await rm(assets, { recursive: true, force: true }); }
  });
  test('rejects untested compatibility, unsigned macOS, unsafe names, and absent runtimes', async () => {
    const assets = await mkdtemp(join(tmpdir(), 'coleo-manifest-'));
    try {
      const base = { version: '1.2.3', compatibility: { testedServer: '1.2.3', requiredCapabilities: [] },
        artifacts: { 'linux-x64': { file: 'operator.tar.gz', format: 'tar.gz' } } };
      await writeFile(join(assets, 'operator.tar.gz'), 'fixture');
      for (const descriptor of [
        { operator: { ...base, runtime: 'bun' } },
        { macos: base },
        { web: { ...base, compatibility: { testedServer: '0.1.0', requiredCapabilities: [] } } },
        { web: { ...base, artifacts: { any: { file: '../escape', format: 'tar.gz' } } } },
      ]) {
        await writeFile(join(assets, 'test.component.json'), JSON.stringify(descriptor));
        await expect(buildReleaseManifest({ assets, version: '1.2.3', commit: 'a'.repeat(40) })).rejects.toThrow();
      }
    } finally { await rm(assets, { recursive: true, force: true }); }
  });
});
