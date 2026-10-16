import { resolve } from 'node:path';
import { isReleaseVersion } from '../shared/version-compatibility';

const root = resolve(import.meta.dir, '../../..');
const manifest = await Bun.file(resolve(root, 'package.json')).json();
const runtimes = await Bun.file(resolve(root, 'packaging/runtimes.json')).json() as Record<string, string>;
for (const runtime of ['bun', 'uv', 'python', 'go']) {
  if (!/^\d+\.\d+\.\d+$/.test(runtimes[runtime] ?? '')) {
    throw new Error(`packaging/runtimes.json must pin a numeric version for ${runtime}`);
  }
}
if (manifest.packageManager !== `bun@${runtimes.bun}`) {
  throw new Error('packaging/runtimes.json Bun pin must match packageManager');
}
const mise = Bun.TOML.parse(await Bun.file(resolve(root, 'mise.toml')).text()) as {
  tools: { bun: string };
  tasks: Record<string, { tools?: { go?: string; uv?: string } }>;
};
if (mise.tools.bun !== runtimes.bun || mise.tasks['test:installer']?.tools?.go !== runtimes.go) {
  throw new Error('mise Bun and installer Go pins must match packaging/runtimes.json');
}
for (const [name, task] of Object.entries(mise.tasks)) {
  if (task.tools?.uv && task.tools.uv !== runtimes.uv) {
    throw new Error(`mise task ${name} uv pin must match packaging/runtimes.json`);
  }
}
if (!isReleaseVersion(manifest.version)) throw new Error(`Invalid release version: ${manifest.version}`);
for (const workspace of manifest.workspaces as string[]) {
  const path = resolve(root, workspace, 'package.json');
  const component = await Bun.file(path).json();
  if (component.version !== manifest.version) {
    throw new Error(`${workspace}/package.json is ${component.version}; expected ${manifest.version}. Update all release packages together.`);
  }
}
const python = await Bun.file(resolve(root, 'pyproject.toml')).text();
const pythonVersion = python.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (pythonVersion !== manifest.version) {
  throw new Error(`pyproject.toml is ${pythonVersion}; expected ${manifest.version}. Update all release packages together.`);
}
const pythonLock = Bun.TOML.parse(await Bun.file(resolve(root, 'uv.lock')).text()) as {
  package?: Array<{ name: string; version: string }>;
};
const lockedPythonVersion = pythonLock.package?.find(component => component.name === 'coleo-inbox')?.version;
if (lockedPythonVersion !== pythonVersion) {
  throw new Error(`uv.lock client version is ${lockedPythonVersion}; expected ${pythonVersion}. Run uv lock.`);
}
const releaseTag = process.env.COLEO_RELEASE_TAG;
if (releaseTag && releaseTag !== `coleo-v${manifest.version}`) {
  throw new Error(`Release tag ${releaseTag} does not match package version ${manifest.version}`);
}
console.log(`All components use Coleo ${manifest.version}`);
