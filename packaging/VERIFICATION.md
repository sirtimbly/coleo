# Track C verification — 2026-10-16

## Independent web installation correction

The installer now installs web's private Bun host and a web-owned Python client
dependency in one atomic generation. `coleo-client web` launches `coleo-web`;
the API service does not host these assets. Tests cover shared CLI/TUI/server
ownership, rollback of both staged distributions, copied host/index/assets, and
a real bundled host serving installed resources with no API server running.
`go test -race ./...`, installer/bootstrap and manifest tests, and
`bun run typecheck` were rerun for this correction. The release smoke script
also exercises `coleo-client web` when a web artifact is included; the full
native release archive build has not been repeated for this correction.

The `web` bundle remains `any`; its manifest declares Bun and client dependencies
and validates their availability on all four supported native platforms.

## Earlier component verification

Local host: macOS 26.5.2 (25F84), arm64. Build tools: Bun 1.3.14,
Go 1.25.9, uv 0.11.8. Installed artifact runtime pins: Bun 1.3.6,
uv 0.11.8, CPython 3.12.12. Artifact/component version: 0.14.4.

Passed:

- `go test -race ./...` from `packaging/installer`: eight top-level tests,
  including runtime provisioning fixtures, shared ownership, CLI/TUI upgrades,
  uninstall, download/checksum/subprocess failure rollback, staged executable
  validation, dry-run, unrelated executable/config preservation, unsafe archives,
  and version/platform rejection. All homes/prefixes are temporary.
- `bun test bin/__tests__/installer-bootstrap.test.ts server/src/scripts/__tests__/build-release-manifest.test.ts`:
  twelve tests, forty-five assertions. Includes latest resolution once, pinned
  invocation, checksum refusal, immutable manifests, and invalid release inputs.
- `shellcheck bin/install.sh bin/uninstall.sh`.
- `bun run docs:build`.
- Workflow YAML parsing and owned-file `git diff --check`.
- Native real-artifact package/build/install smoke using
  `package-components.ts platform`, `build-release-manifest.ts`, and
  `smoke-component-artifacts.ts`. Server, agent, CLI-only, and TUI each installed
  into a fresh temporary HOME/prefix containing spaces **and an apostrophe**,
  with an empty PATH (no ambient Bun/Python/uv). Private runtime provisioning,
  help/version, CLI-only absence of Textual, TUI Textual/WebSockets imports, and
  offline uninstall via the installed `coleo-install` all passed.

The native smoke caught and fixed uv's constraint-path whitespace splitting
(upstream #12639). The installer now invokes uv from its payload directory with
relative constraint/wheelhouse paths and an escaped PEP 508 wheel file URL.
The intentionally empty macOS PATH produces uv's warning about unavailable
`install_name_tool` when provisioning Python; prebuilt wheel installation and all
tested imports/commands still passed without developer tools.

After the canonical Release Please tag correction, `bun run typecheck` passed.
Regression tests now cover numeric, `vX.Y.Z`, and `coleo-vX.Y.Z` inputs; canonical
bootstrap installer/checksum URLs; latest-tag parsing in both bootstrap and Go;
and the manifest builder CLI receiving the actual `coleo-vX.Y.Z` published-event
tag. Metadata stays numeric and asset URLs use `/download/coleo-vX.Y.Z/`.
This correction was verified with fixture/URL tests and builder validation;
the full native artifact build was not repeated.

Not locally verified: Linux x64/arm64, macOS x64, browser runtime behavior, or
signed/notarized macOS application installation. The workflow gates platform
publication on native installed-artifact checks. Apple signing/notarization is
conditional on maintainer-provided credentials and the repository enable variable.
No release was published, no deployment performed, no global tool installed, and
no active Coleo API was used for smoke mutations.
