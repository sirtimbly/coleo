# Component release tooling

`installer/` is a standard-library-only Go program. It deliberately does not
bootstrap through Bun or Python: those are component-specific private runtimes.

```sh
cd packaging/installer
go test -race ./...
CGO_ENABLED=0 go build -trimpath -o coleo-installer .
```

The published binary name is `coleo-installer-{darwin,linux}-{arm64,x64}`. The
bootstrap `bin/install.sh` resolves a release, verifies this binary using that
release's `SHA256SUMS`, and invokes it. Successful installs retain a local
`coleo-install` manager, allowing offline uninstall without the bootstrap.

## Artifact inputs

`COLEO_RELEASE_VERSION=coleo-v0.14.4 bun run server/src/scripts/package-components.ts platform ASSETS`
builds native operator/client archives, a standalone wheel, and pinned runtime
archives. Run on each supported architecture, rather than cross-packaging native
dependencies. `... package-components.ts web ASSETS` builds the web archive.
The web archive includes `host.js`, `index.html`, and assets. Its `any` artifact
declares Bun and the Python client dependency; the installer provisions both
privately and launches it through `coleo-client web` / `coleo-web`.

The operator archive contains `dist/{index,server,agent}.js`, templates, and
production `node_modules`. Client archives contain the `coleo-inbox` wheel,
`constraints.txt` exported with `uv export --frozen --extra tui --no-dev
--no-emit-project`, and the complete hashed platform wheelhouse. There is no PyPI
publication requirement. uv installs dependencies offline from that wheelhouse;
only its pinned Python runtime download requires network access during install.

Each builder writes `*.component.json` descriptors with local filenames.
`build-release-manifest.ts --assets ASSETS --version VERSION --commit FULL_SHA`
merges them, checks metadata/dependencies, computes digests/sizes, and emits
`coleo-release.json` and `SHA256SUMS`. The existing `reef-release.json` is unrelated.
Release input accepts numeric versions, canonical `coleo-vX.Y.Z` tags, and `vX.Y.Z`
aliases. Metadata remains numeric; GitHub asset URLs always use `coleo-vX.Y.Z`.

`smoke-component-artifacts.ts ASSETS` serves the actual archives over loopback and
installs executable roles, including web when present, into disposable homes with a restricted PATH.
It checks help/version and Python CLI-only vs TUI import isolation, then uses the
installed manager to uninstall each role. Its loopback HTTP override is confined
to `COLEO_INSTALL_TEST_HTTP=1`; production downloads require HTTPS.

## Release workflow

`.github/workflows/publish-components.yml` can be dispatched with an existing
`coleo-vX.Y.Z` release tag and `publish=false` for build/test artifacts only. A published-release
event or an explicit `publish=true` attaches assets to an existing GitHub release.
Uploads do not use `--clobber`. Only assemble has release-write permissions.
The four native jobs must pass before publishing the combined manifest. Web
dependencies are installed explicitly before its build.

Version/runtime integration inputs:

- Root `package.json` bins must map `coleo` → `dist/index.js`, `coleo-server` →
  `dist/server.js`, `coleo-agent` → `dist/agent.js`; build includes all three plus templates.
- Root `pyproject.toml` distribution remains `coleo-inbox`, with `coleo-client`
  and `coleo-inbox` entry points and the optional `tui` extra. Its numeric version
  and lock must match the release train before building.
- Keep `packaging/runtimes.json` and workflow setup versions aligned with root
  packageManager/mise/CI. Current pins: Bun 1.3.6, uv 0.11.8, Python 3.12.12,
  Go 1.25.9 (Go is a build dependency only).
- Suggested root tasks (integrator-owned):
  `release:manifest` → `bun run server/src/scripts/build-release-manifest.ts`,
  `test:installer` → `bun test bin/__tests__/installer-bootstrap.test.ts && cd packaging/installer && go test ./...`.
- Add `packaging/runtimes.json` to shared version/runtime checks as appropriate;
  the packaging builder already refuses a Bun/packageManager mismatch.
- Release automation that creates releases using `GITHUB_TOKEN` may not trigger
  another workflow's `release` event. If that is how Release Please is configured,
  explicitly dispatch this workflow with the new tag after release creation, or
  use the maintainer's existing GitHub App token. This is integrator-owned wiring.

## Conditional macOS assets

Without Apple credentials, leave repository variable
`COLEO_MACOS_RELEASE_ENABLED` unset/false. Other components still publish, and the
manifest omits macOS app artifacts. Enable it only with secrets:
`APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`.

The workflow imports the Developer ID certificate into an ephemeral Keychain,
creates notarytool profile `coleo-release`, invokes the existing
`clients/macos/scripts/make-app.sh` with numeric `COLEO_VERSION`, then calls
`clients/macos/scripts/package-release.sh APP OUTPUT.zip` using
`COLEO_SIGNING_IDENTITY` and `COLEO_NOTARY_PROFILE`. That parent-owned script signs,
notarizes, staples, verifies, and emits the zip. The workflow adds a signed/notarized
descriptor only after that command succeeds. The archive root must contain
`ColeoInbox.app`; app installation also verifies `codesign` and `spctl` locally.

## Ownership and rollback

All package payloads and managed runtimes live in unique `stores` directories.
Snapshots contain executable links plus a versioned receipt. A single `current`
symlink rename publishes the complete new selection. The receipt records release,
commit, artifact digest, owners, target API, and private payload path. Shared
operator owners are server/agent; shared Python owners are client/tui/web. Web has
its own Bun runtime and does not install an operator. TUI and web own
the CLI even when client was never installed explicitly. Uninstalling an explicit
owner preserves remaining owners and never removes app configuration/data.

Failed preparation or publication removes its new store and preserves the current
snapshot. Old unreferenced stores are removed only after commit. Prefix executable
collisions abort rather than overwriting user-installed tools. A per-prefix lock
serializes writers. SIGKILL/power loss may leave a stale lock/orphan staging files;
receipt-referenced stores remain authoritative. Installer checksums authenticate
against the HTTPS GitHub release publisher, not a separate offline signing key.
