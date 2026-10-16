import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeReleaseVersion } from './component-release-version';
import type { ComponentInput } from './build-release-manifest';

const root = resolve(import.meta.dir, '../../..');
const pins = await Bun.file(join(root, 'packaging/runtimes.json')).json() as {
  bun: string; uv: string; python: string;
};
const version = normalizeReleaseVersion(process.env.COLEO_RELEASE_VERSION ?? '');
const pkg = await Bun.file(join(root, 'package.json')).json() as { version: string; packageManager: string };
if (pkg.version !== version || pkg.packageManager !== `bun@${pins.bun}`) {
  throw new Error('Normalize release version and align packaging/runtimes.json with packageManager before packaging');
}
const mode = process.argv[2] ?? 'platform';
const output = resolve(process.argv[3] ?? 'release-assets');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'coleo-components-'));
const platform = `${process.platform}-${process.arch}`;
const compatibility = { testedServer: version, requiredCapabilities: [] as string[] };

async function run(cmd: string[], cwd = root): Promise<void> {
  const child = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Failed: ${cmd[0]} ${cmd[1] ?? ''}`);
}
async function download(url: string, path: string): Promise<void> {
  console.error(`Downloading ${url.split('/').at(-1)}`);
  await run(['curl', '--proto', '=https', '--proto-redir', '=https', '--fail', '--location',
    '--silent', '--show-error', '--max-time', '180', '--retry', '2', url, '--output', path]);
}
async function archive(source: string, filename: string): Promise<void> {
  await run(['uv', 'run', '--no-project', '--python', pins.python, 'python',
    join(root, 'packaging/archive.py'), source, join(output, filename)]);
}
async function descriptor(name: string, components: Record<string, ComponentInput>): Promise<void> {
  await writeFile(join(output, `${name}.component.json`), `${JSON.stringify(components, null, 2)}\n`);
}
async function runtime(name: 'bun' | 'uv'): Promise<ComponentInput> {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const bunName = `bun-${process.platform}-${arch}${arch === 'x64' ? '-baseline' : ''}`;
  const uvName = `uv-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`;
  const filename = name === 'bun' ? `${bunName}.zip` : `${uvName}.tar.gz`;
  const base = name === 'bun' ? `https://github.com/oven-sh/bun/releases/download/bun-v${pins.bun}`
    : `https://github.com/astral-sh/uv/releases/download/${pins.uv}`;
  const path = join(output, filename);
  await download(`${base}/${filename}`, path);
  const checksum = join(temp, `${name}.sha256`);
  await download(`${base}/${name === 'bun' ? 'SHASUMS256.txt' : `${filename}.sha256`}`, checksum);
  const lines = (await readFile(checksum, 'utf8')).trim().split('\n');
  const expected = (name === 'bun' ? lines.find(line => line.trim().endsWith(filename)) : lines[0])?.split(/\s+/)[0];
  const actual = createHash('sha256').update(await readFile(path)).digest('hex');
  if (!expected || actual !== expected) throw new Error(`Upstream ${name} checksum mismatch`);
  return { version: pins[name], compatibility, artifacts: {
    [platform]: { file: filename, format: name === 'bun' ? 'zip' : 'tar.gz',
      entry: name === 'bun' ? `${bunName}/bun` : `${uvName}/uv` },
  } };
}

try {
  if (mode === 'web') {
    await run(['bun', 'run', 'setup:web']);
    await run(['bun', 'run', 'web:build']);
    for (const name of ['index.html', 'host.js']) {
      if (!(await Bun.file(join(root, 'clients/web/dist', name)).exists())) throw new Error(`Missing web resource: ${name}`);
    }
    const file = `coleo-web-${version}.tar.gz`;
    await archive(join(root, 'clients/web/dist'), file);
    await descriptor('web', { web: { version, runtime: 'bun', dependencies: ['client'], compatibility,
      artifacts: { any: { file, format: 'tar.gz' } } } });
  } else if (mode === 'platform') {
    if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(platform)) {
      throw new Error(`Unsupported build host: ${platform}`);
    }
    await run(['bun', 'run', 'build']);
    const operator = join(temp, 'operator');
    await mkdir(join(operator, 'clients/web'), { recursive: true });
    for (const file of ['package.json', 'bun.lock', 'clients/web/package.json']) {
      await cp(join(root, file), join(operator, file));
    }
    await cp(join(root, 'dist'), join(operator, 'dist'), { recursive: true });
    await run(['bun', 'install', '--production', '--frozen-lockfile', '--filter', 'coleo', '--linker', 'hoisted'], operator);
    // No source workspace needs to be shipped. Runtime dependencies and templates are self-contained.
    await rm(join(operator, 'clients'), { recursive: true, force: true });
    const operatorFile = `coleo-operator-${version}-${platform}.tar.gz`;
    await archive(operator, operatorFile);
    const client = join(temp, 'client');
    await mkdir(join(client, 'wheels'), { recursive: true });
    await run(['uv', 'build', '--wheel', '--out-dir', client]);
    const wheel = (await readdir(client)).find(file => file.endsWith('.whl'));
    if (!wheel || !wheel.startsWith(`coleo_inbox-${version.replace(/-/g, '')}-`)) {
      throw new Error('Python wheel version must match the normalized release version');
    }
    await cp(join(client, wheel), join(output, wheel));
    const constraints = join(client, 'constraints.txt');
    await run(['uv', 'export', '--frozen', '--extra', 'tui', '--no-dev', '--no-emit-project',
      '--format', 'requirements-txt', '--output-file', constraints]);
    await run(['uv', 'run', '--isolated', '--no-project', '--python', pins.python, '--with', 'pip==25.3',
      'python', '-m', 'pip', 'download', '--require-hashes', '--only-binary=:all:',
      '--dest', join(client, 'wheels'), '--requirement', constraints]);
    const clientFile = `coleo-client-${version}-${platform}.tar.gz`;
    await archive(client, clientFile);
    await descriptor(platform, {
      operator: { version, runtime: 'bun', compatibility,
        artifacts: { [platform]: { file: operatorFile, format: 'tar.gz' } } },
      client: { version, runtime: 'uv', python: pins.python, wheel, compatibility,
        artifacts: { [platform]: { file: clientFile, format: 'tar.gz' } } },
      bun: await runtime('bun'), uv: await runtime('uv'),
    });
  } else throw new Error('Mode must be platform or web');
} finally { await rm(temp, { recursive: true, force: true }); }
