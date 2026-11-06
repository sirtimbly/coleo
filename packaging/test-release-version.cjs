// Run with release-please available through NODE_PATH (see release-packaging.yml).
// Exercise the real updaters: TOML values are tagged objects, not plain strings.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { GenericToml } = require('release-please/build/src/updaters/generic-toml');
const { Version } = require('release-please/build/src/version');
const toml = require('@iarna/toml');

const root = resolve(__dirname, '..');
const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'));
const files = config.packages['.']['extra-files'].filter(file => file.type === 'toml');
const temp = mkdtempSync(join(tmpdir(), 'coleo-release-version-'));
try {
  for (const target of ['1.0.0', '1.1.0']) {
    for (const file of files) {
      const original = readFileSync(join(root, file.path), 'utf8');
      const updated = new GenericToml(file.jsonpath, Version.parse(target)).updateContent(original);
      const before = toml.parse(original);
      const after = toml.parse(updated);
      if (file.path === 'uv.lock') {
        assert.equal(after.package.find(pkg => pkg.name === 'coleo-inbox').version, target);
        before.package.find(pkg => pkg.name === 'coleo-inbox').version = target;
      } else {
        assert.equal(after.project.version, target);
        before.project.version = target;
      }
      assert.deepEqual(after, before, `${file.path}: unrelated metadata changed`);
      writeFileSync(join(temp, file.path), updated);
    }
    execFileSync('uv', ['lock', '--check', '--directory', temp], { stdio: 'inherit' });
    execFileSync('uv', ['sync', '--locked', '--no-install-project', '--no-dev', '--directory', temp], {
      stdio: 'inherit',
    });
  }
  console.log('Release-please propagates simulated 1.0.0 and 1.1.0 versions; uv accepts both locks');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
