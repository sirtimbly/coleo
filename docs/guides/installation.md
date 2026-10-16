# Install Coleo components

Choose the tools for the machine you are installing on:

| Component | Installed interface | Prerequisite provisioned privately |
| --- | --- | --- |
| `server` | `coleo-server`, transitional `coleo` | Pinned Bun |
| `agent` | `coleo-agent` Arm Host | Pinned Bun |
| `client` (alias `cli`) | `coleo-client`, transitional `coleo-inbox` | Pinned uv and managed Python |
| `tui` | Python client with Textual workspace | Same Python tool, with the TUI extra |
| `web` | `coleo-client web` (private `coleo-web` host) | Pinned Bun plus the Python CLI and its managed runtime |
| `macos` | Prebuilt Coleo Workbench application | macOS 14+, published signed/notarized asset |

The component installer becomes available with the first release containing
`coleo-release.json` and `coleo-installer-*` assets. Older releases cannot be
installed through this interface. Use the version shown on the GitHub release;
the examples below use `VERSION` as a placeholder.

## One-step installation

Download the bootstrap from the selected release, then select a component:

```sh
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://github.com/sirtimbly/coleo/releases/download/coleo-vVERSION/install.sh \
  | bash -s -- install client --version VERSION
```

Replace `client` with `server`, `agent`, `tui`, `web`, or `macos`. Bare invocation
still installs **server only**. No Python is needed for server/agent installation;
no Bun or existing Python is needed for client/TUI installation. Installation
does not start a service or write connection credentials.

Release tags are `coleo-vX.Y.Z`. Version arguments accept `X.Y.Z`, `coleo-vX.Y.Z`,
or the shorthand `vX.Y.Z`; downloads always use the canonical `coleo-v` tag.

The bootstrap needs Bash, curl, standard system utilities, and `sha256sum` or
macOS `shasum`. The standalone installer needs no language runtime. Supported
release targets are Linux **glibc** and macOS, x64/arm64, when the corresponding
asset has passed the release matrix. Windows and musl are not supported.

Installation defaults to `$HOME/.local`. Select another user-owned prefix with
`--prefix "/path/with spaces"` or `COLEO_INSTALL_PREFIX`. No sudo, shell-profile
changes, or global tool installation is performed. Add the printed bin directory:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

`coleo-install` is retained in that directory for subsequent operations. To preview
an operation, add `--dry-run`; it resolves and validates the release selection but
does not create the installation prefix or provision runtimes. The bootstrap
itself still downloads its verified executable to a temporary directory.

## Configure and connect

```sh
# API service and optional brain, on the server host
coleo-server configure
coleo-server start
coleo-server brain start

# Arm Host, with its own NATS connection configuration
coleo-agent configure
coleo-agent start

# Remote API client
coleo-client connect https://coleo.example.com --name production
coleo-client tasks

# If the tui component is installed
coleo-client tui
```

Use `--api-url https://coleo.example.com` during client installation to customize
the printed connection command. It does not save credentials or contact that API.
Do not embed credentials in URLs. Client connection configuration and Arm Host
NATS configuration are separate.

## Upgrade and uninstall

```sh
coleo-install upgrade client --version VERSION
coleo-install install tui --version VERSION
coleo-install uninstall tui
coleo-install uninstall client
```

Always repeat `--prefix` when using a nondefault prefix. Versions select a tested
release manifest, not an assumption that every component's version is identical.
`latest` is resolved once before downloads. Reinstalling a pinned release is safe.

Receipts live at `PREFIX/lib/coleo/current/receipt.json`. Server and agent share
one operator distribution and Bun runtime: upgrading either upgrades that shared
distribution, and uninstalling one preserves the other. The Python client and TUI
likewise share one tool environment. Installing TUI includes the CLI; upgrading
the client preserves an installed TUI. Uninstall removes the selected explicit
owner. If another owner remains, its shared environment remains (including TUI
dependencies until the next CLI-only reinstall). Removing the last owner removes
that tool and its private runtime. The small `coleo-install` manager is retained.

Downloads, checksum verification, extraction, runtime provisioning, and executable
creation happen before an atomic current-generation switch. Failure preserves the
previous commands and receipt. Unrelated executables are never overwritten.
Stop managed services before upgrading their executable distribution, then restart
them after success. Configuration and application data are always preserved;
remove them separately only when intentionally discarding that data.

An interrupted installer may leave `PREFIX/lib/coleo/install.lock`. Check that no
installer is running before removing a stale lock and retrying. Unreferenced
staging directories from an uncatchable interruption may remain under `stores`;
do not remove any path named by the current receipt.

## Browser client

```sh
coleo-install install web --version VERSION --api-url http://127.0.0.1:8080
coleo-client connect http://127.0.0.1:8080 --name default
coleo-client web
```

The client starts its own local web host and prints the browser URL. It uses the
selected API connection, forwarding `COLEO_API_URL` and `COLEO_API_KEY` to the
private host. The API backend is API-only. No server or agent installation is
needed on the client machine. `--api-url` customizes the printed connection command.

Web owns a dependency on the Python CLI. Uninstalling an explicitly installed
`client` preserves that CLI while web needs it. Uninstalling `web` removes its
host and private Bun, and preserves explicit client/TUI and server/agent owners.
The web archive contains `host.js`, `index.html`, and assets; its platform-independent
bundle uses the target platform's private Bun runtime.

## macOS application

```sh
coleo-install install macos --version VERSION
open "$HOME/.local/lib/coleo/current/macos"
```

The app stays inside the user prefix; it is not copied over an existing application.
The installer verifies code signing and Gatekeeper assessment. If the selected
release lacks a notarized asset for your architecture, installation reports that
directly. It never builds Swift or substitutes an ad-hoc-signed app.

## Release integrity and isolated Python tools

The HTTPS release manifest records commit, component versions, supported targets,
runtime requirements, tested server compatibility, immutable asset URLs, sizes,
and SHA-256 digests. The bootstrap verifies the standalone installer against the
same release's `SHA256SUMS`; the installer verifies each artifact before extracting
it. This trusts the GitHub release publisher and HTTPS, not an independent signing
key. Archive traversal, links, devices, and other special entries are rejected.

Python wheels are GitHub release assets, with a platform wheelhouse and constraints
exported from `uv.lock`. Dependencies are installed from that verified archive
without consulting a package index. The pinned uv release provisions an exact
private Python version using its upstream checksummed runtime catalog. Existing
Bun, Python, uv, and their tool directories are left alone.

Checkout development still uses the repository's `setup:cli`, `setup:tui`, and
`setup:web`/mise tasks. Those tasks are distinct from installing release artifacts.
