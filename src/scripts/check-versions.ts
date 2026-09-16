import { resolve } from 'node:path';
import { isReleaseVersion } from '../shared/version-compatibility';

const root = resolve(import.meta.dir, '../..');
const manifest = await Bun.file(resolve(root, 'package.json')).json();
if (!isReleaseVersion(manifest.version)) throw new Error(`Invalid release version: ${manifest.version}`);
for (const workspace of manifest.workspaces as string[]) {
  const path = resolve(root, workspace, 'package.json');
  const component = await Bun.file(path).json();
  if (component.version !== manifest.version) {
    throw new Error(`${workspace}/package.json is ${component.version}; expected ${manifest.version}. Update all release packages together.`);
  }
}
const releaseTag = process.env.COLEO_RELEASE_TAG;
if (releaseTag && releaseTag !== `coleo-v${manifest.version}`) {
  throw new Error(`Release tag ${releaseTag} does not match package version ${manifest.version}`);
}
console.log(`All components use Coleo ${manifest.version}`);
