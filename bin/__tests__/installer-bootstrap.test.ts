import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const bootstrap = resolve(import.meta.dir, '../install.sh');

async function fixture(args: string[], corrupt = false, envVersion = 'latest'): Promise<{ code: number; args: string; calls: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'coleo-bootstrap-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const payload = '#!/bin/sh\nprintf "%s\\n" "$@" > "$FIXTURE/args"\n';
    await writeFile(join(dir, 'installer'), payload);
    const digest = corrupt ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex');
    await writeFile(join(dir, 'sums'), `${digest}  coleo-installer-darwin-arm64\n`);
    await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n', { mode: 0o755 });
    await writeFile(join(bin, 'curl'), `#!/bin/sh
set -eu
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1";;
    https:*) url="$1";;
  esac
  shift
done
printf '%s\\n' "$url" >> "$FIXTURE/calls"
case "$url" in
  */latest) printf 'https://github.com/sirtimbly/coleo/releases/tag/coleo-v1.2.3';;
  */SHA256SUMS) cp "$FIXTURE/sums" "$out";;
  */coleo-installer-darwin-arm64) cp "$FIXTURE/installer" "$out";;
  *) exit 1;;
esac
`, { mode: 0o755 });
    const child = Bun.spawn(['bash', bootstrap, ...args], {
      env: { ...process.env, HOME: dir, TMPDIR: dir, FIXTURE: dir, COLEO_VERSION: envVersion,
        PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe',
    });
    const code = await child.exited;
    const invoked = await readFile(join(dir, 'args'), 'utf8').catch(() => '');
    return { code, args: invoked, calls: await readFile(join(dir, 'calls'), 'utf8') };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('release bootstrap', () => {
  test('bare invocation resolves latest exactly once and pins the installer invocation', async () => {
    const result = await fixture([]);
    expect(result.code).toBe(0);
    expect(result.args).toBe('--version\n1.2.3\n');
    expect(result.calls.split('\n').filter(line => line.endsWith('/latest'))).toHaveLength(1);
    expect(result.calls).toContain('/download/coleo-v1.2.3/coleo-installer-darwin-arm64');
    expect(result.calls).toContain('/download/coleo-v1.2.3/SHA256SUMS');
  });
  test.each(['1.2.3', 'v1.2.3', 'coleo-v1.2.3'])('normalizes pinned %s to canonical release paths', async version => {
    const result = await fixture(['install', 'tui', '--version', version, '--prefix', '/tmp/a path']);
    expect(result.code).toBe(0);
    expect(result.args).toBe(`install\ntui\n--version\n${version}\n--prefix\n/tmp/a path\n--version\n1.2.3\n`);
    expect(result.calls).not.toContain('/latest');
    expect(result.calls).toContain('/download/coleo-v1.2.3/coleo-installer-darwin-arm64');
    expect(result.calls).toContain('/download/coleo-v1.2.3/SHA256SUMS');
  });
  test('normalizes a canonical COLEO_VERSION environment tag', async () => {
    const result = await fixture(['client'], false, 'coleo-v1.2.3');
    expect(result.code).toBe(0);
    expect(result.args).toBe('client\n--version\n1.2.3\n');
    expect(result.calls).not.toContain('/latest');
    expect(result.calls).toContain('/download/coleo-v1.2.3/coleo-installer-darwin-arm64');
  });
  test('checksum failure prevents executing the downloaded installer', async () => {
    const result = await fixture(['client'], true);
    expect(result.code).toBe(1);
    expect(result.args).toBe('');
  });
});
