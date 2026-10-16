import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { ReleaseManifest } from './build-release-manifest';

// Release gate: test actual archives and managed runtimes, with no ambient Bun/Python/uv.
const assets = resolve(process.argv[2] ?? 'release-assets');
const manifest = JSON.parse(await readFile(join(assets, 'coleo-release.json'), 'utf8')) as ReleaseManifest;
const binary = join(assets, `coleo-installer-${process.platform}-${process.arch}`);
const temp = await mkdtemp(join(tmpdir(), 'coleo-artifacts-'));
const path = join(temp, 'path');
await mkdir(path);
if (process.platform === 'linux') await symlink('/usr/bin/ldd', join(path, 'ldd'));
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (name === 'coleo-release.json') return Response.json(manifest);
    if (basename(name) !== name) return new Response('Not found', { status: 404 });
    return new Response(Bun.file(join(assets, name)));
  },
});
const origin = `http://127.0.0.1:${server.port}`;
for (const component of Object.values(manifest.components)) {
  for (const artifact of Object.values(component.artifacts)) {
    artifact.url = `${origin}/${basename(new URL(artifact.url).pathname)}`;
  }
}

async function run(cmd: string[], home: string): Promise<void> {
  const child = Bun.spawn(cmd, {
    cwd: temp, env: { ...process.env, HOME: home, PATH: path, COLEO_INSTALL_TEST_HTTP: '1',
      COLEO_DIR: join(home, '.coleo'), XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share') },
    stdout: 'inherit', stderr: 'inherit',
  });
  if (await child.exited !== 0) throw new Error(`Installed-artifact smoke failed: ${cmd[0]}`);
}
try {
  for (const component of ['server', 'agent', 'client', 'tui', ...(manifest.components.web ? ['web'] : [])]) {
    const home = join(temp, `home-${component}`);
    const prefix = join(home, "prefix with spaces and ' quotes");
    await mkdir(home);
    const install = [binary, 'install', component, '--prefix', prefix, '--version', manifest.version,
      '--manifest', `${origin}/coleo-release.json`];
    await run(install, home);
    const executable = join(prefix, 'bin', component === 'tui' ? 'coleo-client' : `coleo-${component}`);
    await run([executable, '--version'], home);
    await run([executable, '--help'], home);
    if (component === 'web') {
      const client = join(prefix, 'bin/coleo-client');
      await run([client, 'web', '--help'], home);
      const receipt = JSON.parse(await readFile(join(prefix, 'lib/coleo/current/receipt.json'), 'utf8'));
      if (receipt.packages.operator) throw new Error('Web installed an API server');
      for (const resource of ['host.js', 'index.html', 'assets']) {
        await access(join(receipt.packages.web.path, 'payload', resource));
      }
      const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
      const port = probe.port;
      probe.stop(true);
      const host = Bun.spawn([client, 'web', '--host', '127.0.0.1', '--port', String(port)], {
        cwd: temp, env: { ...process.env, HOME: home, PATH: `${join(prefix, 'bin')}:${path}`,
          COLEO_API_URL: 'http://127.0.0.1:1', COLEO_API_KEY: '', XDG_CONFIG_HOME: join(home, '.config') },
        stdout: 'inherit', stderr: 'inherit',
      });
      try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}`);
            if (response.ok && (await response.text()).includes('<html')) { ready = true; break; }
          } catch { /* host is starting */ }
          await Bun.sleep(100);
        }
        if (!ready) throw new Error('Installed coleo-client web did not serve its resources');
      } finally { host.kill('SIGINT'); await host.exited; }
      await run([binary, 'install', 'client', ...install.slice(3)], home);
      await run([binary, 'uninstall', 'client', '--prefix', prefix], home);
      await run([client, '--version'], home);
      await run([executable, '--version'], home);
      await run([binary, 'install', 'client', ...install.slice(3)], home);
    }
    if (component === 'client' || component === 'tui') {
      const receipt = JSON.parse(await readFile(join(prefix, 'lib/coleo/current/receipt.json'), 'utf8')) as {
        packages: { client: { path: string } };
      };
      const python = join(receipt.packages.client.path, 'tools/coleo-inbox/bin/python');
      await access(python);
      await run([python, '-c', component === 'tui'
        ? 'import textual, websockets, coleo_inbox.cli'
        : 'import coleo_inbox.cli, importlib.util; assert importlib.util.find_spec("textual") is None'], home);
    }
    await run([join(prefix, 'bin/coleo-install'), 'uninstall', component, '--prefix', prefix], home);
    if (component === 'web') await run([join(prefix, 'bin/coleo-client'), '--version'], home);
  }
} finally {
  server.stop(true);
  await rm(temp, { recursive: true, force: true });
}
