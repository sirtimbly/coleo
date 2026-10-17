# Component CLI integration verification

Date: 2026-10-16. Implementation verification for PR #123; no release published.

## Implemented integration

- Bun package owns `coleo`, `coleo-server`, `coleo-agent`; Python owns
  `coleo-client` and compatible `coleo-inbox`.
- Root builds emit all three executable bundles and include operator templates.
- Daemon tests are included in unit/watch scripts. Development API/brain scripts
  run foreground processes with coordinated shutdown.
- Python dispatch includes arms/agents/activity/status and
  mail/discoveries/config/status-reports, independently of module catalogs.
- Legacy domain registrations print explicit client replacements without running
  local data fallbacks. Local arm logs, summarizer/backfill, initialization,
  IMAP/MCP, Git helpers, and prompt diagnostics retain their local roles.
- Root package, Python, and web release versions are checked together. macOS build
  metadata derives from the root release. Signing/notarization packaging requires
  maintainer-provided Keychain credentials.

## Evidence collected

- `bun run versions:check`: passed (0.14.4).
- `bun run build`: passed; bundles index/server/agent and brain templates.
- `bun run typecheck`: passed after command-registration integration.
- `bun run docs:build`: passed.
- `bun run shellcheck`: passed at integration checkpoint.
- `bash -n clients/macos/scripts/{make-app,package-release}.sh`: passed.
- `bun pm pack --ignore-scripts`: archive includes three executables, brain and arm
  templates; excludes web assets and environment files for the server-only profile.
- Extracted operator archive outside checkout: server help and agent version passed
  without relying on repository-relative modules.
- CLI-only wheel installed in an isolated Python 3.12 environment outside checkout:
  version, root help, mail help, connections JSON passed. Textual and websockets
  confirmed absent. This first packaging check precedes final streaming integration.
- Connection/communication/catalog integration selection: 82 passed.
- Actual legacy subprocess migration tests: 2 passed, 17 assertions; stdout remains
  empty, replacement goes to stderr, no local runtime state is created.
- Final owned-fixture Python full run: **271 passed**. Includes TUI/PTY and real API
  fixture integration. Diagnostic redaction covers resolved and injected API keys.
- Focused Bun CLI/daemon/task/discovery/transcript integration: **188 passed**,
  1808 assertions. The legacy Inbox subprocess test now asserts migration behavior.
- Rebuilt and reinstalled final CLI-only wheel outside checkout: nine domain help
  commands passed; saved-profile switching between two owned HTTP servers verified
  actual request routing via `doctor`. Textual/websockets remained absent.
- Installed the TUI extra in a separate isolated environment: workbench imports and
  packaged catalog resources passed.
- Full `bun run test`: **1422 unit tests passed, 19 existing TODOs; 33 integration
  tests passed**. Fixed the task-preparation test's inherited provider configuration
  so its fallback test cannot contact a real model provider.
- Installed-layout live operator integration: actual API and ArmAgent against owned
  authenticated NATS 2.12.3 passed configure/start/status/restart/logs/doctor/stop,
  stable identity, restart options, registration, and process cleanup. Qdrant used
  an owned 503 fixture to verify startup fallback. Reproducible command:
  `bun server/src/cli/__tests__/operator-installed.integration.ts`.
- Final operator hardening: **35 targeted tests passed**, plus root typecheck and
  rebuilt installed-layout lifecycle integration. Registration/removal locking
  preserves replacement records; exported credential aliases precede env-file keys.
  Arm recovery uses scoped launch ownership rather than global process enumeration.
  The unrelated-arm fixture received zero requests and remained alive. Legacy arms
  without ownership records require explicit migration; automatic adoption is omitted.
- Web production build and final documentation build passed.
- Component installation is implemented as a standalone Go manager with private
  runtimes and a Bash bootstrap. Native macOS arm64 real-artifact checks passed
  server/agent/CLI/TUI installation into empty-PATH temporary homes, including
  prefixes containing spaces/apostrophes, dependency isolation, and offline removal.
  See `packaging/VERIFICATION.md` for platform details. Root typecheck now passes,
  including the task-preparation mock mentioned in that track's earlier report.
- Added `mise run test:installer` with task-scoped Go 1.25.9 and an installer CI job.
  Release/runtime checks validate Bun, uv, and Go pins against `packaging/runtimes.json`.
  Release Please also updates the Python project's own version in `uv.lock`.
- Final `bun run test:installer`: **12 bootstrap/manifest tests passed**, 45
  assertions; **8 Go installer tests passed under the race detector**. Regression
  coverage verifies Coleo's canonical `coleo-vX.Y.Z` tags throughout bootstrap,
  latest resolution, generated artifact URLs, and builder inputs.

Agent-owned focused results and contract differences are recorded in
`domain-cli-parity.md`, `remote-cli-parity.md`, and `communication-cli-parity.md`.

## API-only hosting correction

The subsequent user-requested hosting change supersedes the original optional
API-static-hosting design:

- Removed all API static-asset discovery, SPA handling, and `webDist` configuration.
  UI routes return 404 even with legacy hosting environment variables set.
- `coleo-client web` launches installed `coleo-web` with the selected connection
  in its environment. The web component owns its host bundle, private Bun runtime,
  and a shared Python CLI dependency; it does not require a server installation.
- Hosting implementation lives in `clients/web/server.ts` with its entry point in
  `clients/web/host.ts`. HTTP/uploads/WebSocket proxying passes the selected API
  credential upstream, including the API's proxy-authenticated WebSocket header.
- Bundled containers launch separate API and web processes; public ports are
  preserved. The default internal API listener is `127.0.0.1:8081`.
- Updated the commit-message draft, installation documentation, and build scripts.
- Verification: **280 Python tests passed**; **18 focused API/proxy/container tests
  passed**; server/web-host/docs builds, web lint, root typecheck and shellcheck passed.
- Updated installer verification: **13 bootstrap/manifest tests passed**, 47
  assertions, and the Go installer race suite passed, including installed web
  hosting and dependency ownership without an API server installation.

## Release evidence boundaries (current)

Local runtime: macOS, Bun 1.3.14, Python 3.12.14. CI/mise and installer runtime pins
now use Bun 1.3.14: the 1.3.6 WebSocket client rejects valid negotiated
subprotocols with `Mismatch client protocol`. The proxy regression test reproduces
the failure on 1.3.6 and passes on 1.3.14.
Platform release jobs must validate their declared matrix before publishing assets.
No Apple signing/notarization credentials were provided in this session; a local
syntax check is not a signed application release. No production server mutations
are part of verification; service checks use temporary directories and owned ports.
