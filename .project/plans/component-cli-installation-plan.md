# Component CLIs and installation: execution plan

Date: 2026-10-16
Status: implemented for PR #123; release publication and platform CI remain release gates.
See [integration verification](../reports/component-cli-installation-verification.md)
and [installer verification](../../packaging/VERIFICATION.md) for evidence and scope.

## Goal

Ship explicit local operator tools and an API-only user client, with independently
installable CLI, TUI, web, and macOS interfaces. A user can install a server, an
Arm Host, or a client and receive working commands plus clear connection instructions.

The user has approved the division:

- `coleo-server`: API/brain process lifecycle, host configuration, local diagnostics.
- `coleo-agent`: Arm Host process lifecycle, host configuration, local diagnostics.
- `coleo-client`: selected-server API operations, Rich output, JSON, optional TUI.
- `coleo`: temporary compatibility entry point during migration.

## Current baseline and integration requirements

The working tree already contains the optional Python TUI extra, `coleo-client`
alias, task-scoped mise tools, `clients/web` relocation, optional static hosting,
and installation/connection documentation. These changes are prerequisites and
must be preserved. macOS notification work is separate user work.

Before implementation agents start editing:

1. Integrator records `git status` and isolates the prerequisite changes in a
   reviewed checkpoint or common worktree baseline. Do not sweep unrelated macOS
   changes into that checkpoint.
2. Give every agent the same baseline and this plan, plus the applicable AGENTS.md.
3. Agents report additional existing modifications before touching their files.
4. Root manifests, lockfiles, shared command registration, and release workflows
   have a single editor: the integrator, except where explicitly assigned below.

Previously verified behavior is a baseline, not proof of new work. Each track
must run its acceptance checks against its final changes.

## Shared contracts: settle before parallel implementation

### Executables and command meanings

| Executable | Commands for first release | Meaning |
| --- | --- | --- |
| `coleo-server` | `configure`, `run`, `start`, `stop`, `restart`, `status`, `logs`, `doctor` | API service on the host running the command; `run` stays foreground |
| `coleo-server brain` | `run`, `start`, `stop`, `restart`, `status`, `logs` | Brain service on the host running the command |
| `coleo-agent` | `configure`, `run`, `start`, `stop`, `restart`, `status`, `logs`, `doctor` | Arm Host service on the host running the command |
| `coleo-client` | existing domain commands plus `connect`, `connections`, `use`, `doctor` | API operations against a resolved connection profile |

Both operator `start` commands launch a background service; `run` stays in the
foreground. `status` reports process identity, running state, and relevant local
paths. Remote fleet status is `coleo-client agents`, not `coleo-agent status`.
`coleo-server start` starts the API only; users start the brain explicitly.

Keep the approved root API verbs for `coleo-server`; use its `brain` namespace for
brain lifecycle. The legacy `coleo agent start` retains its existing foreground
behavior until retired. New `coleo-agent start` is explicitly background; its
migration message points foreground users to `coleo-agent run`.
New operator executables show help when invoked without a subcommand.

Initial instance model: one managed agent per `COLEO_DIR`. Multiple agent instances
use separate runtime directories. Save a stable configured agent ID for restarts;
generate it once during configuration instead of including a changing process ID.
Stopping the host preserves the runtime's current managed-arm behavior; document
that host shutdown is distinct from API commands to terminate individual arms.

Every executable provides offline `--help`, `--version`, and `--json` for bounded
status/configuration/diagnostic operations. Help identifies whether an operation
targets a host process or a selected server. New examples use canonical names;
old names remain documented as compatibility paths until cutover.

### Configuration

Precedence: explicit command flags > exported environment > selected saved
configuration > defaults. Resolution returns both values and their sources.
Configuration and diagnostic output redact credentials.

- Client profile selection: `--connection NAME`, then `COLEO_CONNECTION`, then
  saved active profile. Unknown explicit names fail before sending a request.
- Client endpoint overrides: `--server URL` and `COLEO_API_URL`.
- HTTP credential: `COLEO_API_KEY`; interactive configuration uses a hidden prompt.
  Automation can provide a key through stdin or the environment. Avoid putting
  credentials in URLs or examples with command-line secret values.
- Arm Host transport: `COLEO_NATS_URL`/`COLEO_NATS_TOKEN`, host workspace, agent ID,
  and maximum arms. API connection and NATS connection are separate settings.
- Client profiles use the existing client config-directory resolver and a new
  versioned connections file; module catalogs remain independent.
- Operator configuration is scoped to the selected runtime directory. Preserve
  current environment-file behavior while defining how saved settings enter the
  resolver. Do not change existing environment precedence accidentally.
- Use atomic writes, validate before replacing saved config, and protect saved
  credential files with owner-only permissions on supported systems. Document
  the chosen storage mechanism; do not introduce a new credential backend per tool.

`connect URL --name NAME` validates the URL, checks server connectivity and
authentication, saves a named profile, and selects it. Failed validation leaves
the previous active profile intact. Add `--save-only` for intentional offline
configuration. `use NAME` selects a saved profile without needing network access.
`connections --json` lists profile names, endpoints, active selection, and credential
presence, never credential values.

### Output and errors

- Human output: concise operation result, target identity, and one relevant next step.
- JSON output: one versioned object on stdout for one-shot commands. Progress,
  subprocess output, and compatibility notices go to stderr.
- Preserve existing command-specific JSON contracts. New diagnostic envelopes use
  `schemaVersion`, `kind`, `component`, `checks`, and an overall `ok` value.
- Exit 0: completed operation; 1: invalid input/request/process failure;
  2: partial result or failed diagnostic checks; 130: user interruption.
- Streaming commands document their record format separately from one-shot JSON.
- Distinguish unreachable service, authentication rejection, unsupported capability,
  invalid configuration, and local executable absence. Include a corrective command
  when known. Never retry a mutation through another backend after failure.

Example output contract:

```text
Connected to production
Server: https://coleo.example.com

View tasks:     coleo-client tasks
Open workspace: coleo-client tui
```

### Release and compatibility

The Bun distribution owns `coleo-server`, `coleo-agent`, and transitional `coleo`.
The Python distribution owns `coleo-client` and transitional `coleo-inbox`.
Keep the current Python distribution name until a separately reviewed rename;
executable naming does not require a distribution rename.

Use the existing Coleo release identifier to select a tested component set. Record
component versions and server capability requirements in a release manifest;
do not infer compatibility from identical version strings.

Initial release decisions:

- Publish versioned Python wheels and web archives as GitHub release assets;
  PyPI publishing can be added after package ownership/trusted publishing is configured.
- Use one release train, normalizing embedded Python/macOS version metadata at
  release time. Keep per-component version fields in the manifest.
- Name the new manifest `coleo-release.json`; preserve the separate existing
  `reef-release.json` container contract.
- Support macOS and Linux glibc (arm64/x64) only where clean-host tests pass.
  macOS application assets require macOS 14+ and tested architecture coverage.
- Bare existing bootstrap invocation retains server-only installation. Explicit
  component selection opts into the prerequisites for that component; no additional
  interactive runtime approval is required in noninteractive installation.
- Installation and configuration/startup are separate operations. Print the configure
  and start commands after install; optional interactive onboarding can execute
  those operations when selected.
- Web ships as an independently installed client with its own host process,
  launched by `coleo-client web`. The API server never serves UI assets. The web
  host proxies API, uploads, and WebSockets using the selected client connection.
- Apple signing/notarization credentials and the final installer publication URL
  are release inputs to obtain from the maintainer. Their absence does not block
  local operator/client development or fixture-based installer tests.

## Execution graph and assignments

```text
P0 baseline + shared contracts
 ├─ A operator entry points and service lifecycle
 ├─ B Python connections and diagnostics
 └─ C component installer and release artifacts (build against agreed bin contract)
       A + B + C → I1 installed-artifact integration
 B → D1 agents/arms → D2 activity → D3 mail → D4 discoveries/settings
       each D family → compatibility removal for that family
 I1 + D acceptance → R release documentation and clean-host matrix
```

Use three implementation agents for A/B/C. Reassign them to bounded D work after
the first integration checkpoint. The integrator owns cross-track wiring and review.

### A — Operator tools

Primary ownership: new operator entry points under `server/src/cli/`, local
configuration helpers, `server/src/daemon/`, local lifecycle portions of agent/brain/
serve commands, and adjacent tests. Root package/bin/build edits are supplied to
the integrator as an explicit requested patch.

Deliverables:

1. Add separate program constructors and executable entry points. Reuse lifecycle
   services rather than invoking the old CLI in subprocesses.
2. Provide API and brain lifecycle commands under `coleo-server`.
3. Add Arm Host background lifecycle support and a foreground `run` command.
   Pass agent ID, workspace, NATS connection, capacity, and heartbeat options through
   startup and restart. Preserve graceful SIGINT/SIGTERM cleanup.
4. Add `configure` with interactive prompts and noninteractive flags. Report which
   runtime directory will be affected before saving.
5. Add local `doctor` checks: Bun version, configuration validity, required paths,
   selected ports, executable availability, process state, NATS connectivity for
   agents, and API connectivity when configured. Connectivity checks are read-only.
6. Verify daemon subprocesses invoke the correct new executable/foreground command
   in both source checkout and bundled/installed layouts.
7. Keep transitional aliases where semantics are unchanged; split mixed local/API
   status commands explicitly in help and migration mapping.

Audit-specific implementation points:

- Add `server/src/cli/server.ts`, `agent.ts`, and import-safe program factories;
  proposed bundle outputs are `dist/server.js`, `dist/agent.js`, and legacy `dist/index.js`.
- Extend `server/src/daemon/index.ts` service types/metadata for the agent. Resolve
  subprocess entry points by role in `cli/entrypoint.ts`; its current argv-based
  lookup cannot simply be reused for split executable launches.
- Forward host/port and brain/agent options through startup and restart; current
  background wrappers omit some options. Save nonsecret launch settings separately
  from PID metadata; source credentials through configuration/environment.
- Replace or correctly handle existing `nohup` shell interpolation when forwarding
  arguments. Test paths/arguments with spaces and metacharacters.
- Detect duplicate registration, startup readiness and failed stop before restart;
  an existing process or a two-second sleep alone is not readiness evidence.
- Define log retention across restarts. Implement requested log following, or
  return a clear unsupported-option error rather than accepting an ignored flag.
- Reuse `ArmAgent.start()/stop()` in `server/src/agent/arm-agent.ts`; change that
  large runtime only for a narrowly tested lifecycle requirement.

Acceptance:

- Offline help/version and process status work with no running API.
- Disposable service fixtures prove start/status/stop/restart and correct PID ownership.
- Stop handles a stale PID without targeting an unrelated process.
- Foreground shutdown awaits child cleanup; background startup reports failure.
- Two selected runtime directories produce independent service state/log paths.
- Restart preserves the resolved connection and agent identity.
- Operator command constructors expose local lifecycle operations, not migrated
  workspace-domain commands.

### B — Python connections and diagnostics

Primary ownership: new connection/configuration/diagnostic modules under
`clients/python/src/coleo_inbox/`, Python API transport integration, CLI argument
dispatch, and corresponding tests. Coordinate root `pyproject.toml`/`uv.lock` changes
through the integrator. Treat catalog configuration and TUI document state as
existing independent features.

Deliverables:

1. Implement versioned profile storage and resolution with provenance.
2. Add `connect`, `connections`, `use`, offline version/help, and `doctor`.
3. Resolve global connection flags before constructing `Api`. Pass one resolved
   connection into domain commands and TUI hosts.
4. Reserve new host command/flag names against imported module catalog collisions.
5. Implement specific transport/auth/capability errors; retain compatibility with
   existing one-shot result envelopes and optional TUI import handling.
6. Use existing public health/version endpoints where possible. Submit a bounded
   API proposal for missing capability/authentication checks; avoid probing writes
   or requiring a newer endpoint just to list ordinary existing data.
7. Make `doctor` show endpoint, selected profile, configuration sources, auth status,
   server version/capabilities where available, and optional TUI availability.

Audit-specific implementation points:

- Use a separate `connections.json` so `module_catalog.py`'s existing settings
  rewrite cannot discard profiles. Test catalog selection and profile updates together.
- Keep `--profile` for the existing named-view/workbench query profile. Use
  `--connection` for server selection and `--server` for the endpoint override.
- Construct `Api` after configuration validation inside friendly error handling.
- `GET /api/health` is public reachability only. Validate authentication through
  `GET /api/status`, which also exposes version, project name, and server cwd.
  Report development-auth bypass distinctly; health alone cannot validate a key.
- There is no general client API-capability manifest today. Report capabilities
  as unknown for older servers; integrator owns adding a stable authenticated route
  if needed. Arm execution capabilities are a different contract.
- Preserve HTTP status before parsing error bodies. Handle HTML/non-JSON errors,
  timeouts, TLS failures, and 401/403 separately. Send the supported `X-API-Key`
  header; a Bearer header alone is not accepted by the current API middleware.
- Obtain client version from Python distribution metadata for `coleo-inbox`.
  Help/version and connection commands must work with a malformed or missing catalog.
- Extend the API transport with explicit PATCH/DELETE support before domain
  migrations that need them; preserve the old request signature for existing callers.

Acceptance:

- Table-driven tests cover every precedence combination and unknown profile.
- Connect failure leaves previous configuration intact; save-only and use work offline.
- Config writes survive interruption; malformed files produce actionable errors.
- CLI-only installed wheel imports no Textual/WebSocket dependencies.
- `--json` diagnostics contain no credentials, ANSI, banners, or tracebacks.
- TUI and one-shot commands use the same resolved endpoint/key.
- HTTP failures do not trigger local database access or automatic mutation retries.

### C — Installer and release artifacts

Primary ownership: new component installer helpers/tests in `bin/` or
`server/src/scripts/`, release artifact definitions, and installation guide drafts.
The integrator applies root package/mise/lockfile changes and assigns specific
workflow files before C edits them. Coordinate macOS artifact work with its owner.

Target interface (choose the final published bootstrap URL during release wiring):

```text
installer install server|agent|client|tui|web|macos --version VERSION
installer upgrade COMPONENT --version VERSION
installer uninstall COMPONENT
```

Deliverables:

1. Implement a shared manifest reader that resolves versioned artifacts, supported
   platforms/architectures, dependencies, checksums, and executable names.
2. Reuse existing Bun bootstrap for server/agent installation. Python client/TUI
   installation uses uv-managed isolated tools and compatible Python provisioning.
3. Package web assets separately with a defined static/proxy launch path. Installation
   records the API target and prints the `coleo-client web` launch command. Web
   installation supplies its host runtime and the CLI launcher without a server install.
4. Provide macOS artifact installation when an appropriate release asset exists;
   report unsupported/unpublished artifacts directly rather than building silently.
5. Support noninteractive flags and an optional interactive component picker. A
   server installer may offer clients after successful setup, with the explicit
   one-step commands printed for later use.
6. Make upgrades preserve configuration and data. Record installed components and
   ownership so uninstall removes selected binaries/runtime assets and preserves
   configuration unless explicitly requested otherwise.
7. Keep `setup:cli`, `setup:tui`, `setup:web` as checkout tasks. Align their messages
   with release installation without requiring a running server.

Proposed concrete files for C (assign before launch):

- `bin/install.sh`, new `bin/uninstall.sh`, installer helpers and owned fixtures.
- `packaging/release-manifest.schema.json`, `packaging/components.json`.
- `server/src/scripts/build-release-manifest.ts`, its tests, and version checks.
- `.github/workflows/publish-components.yml` and assigned npm publishing updates.
- `docs/guides/installation.md` draft; integrator handles navigation and overview edits.
- macOS release scripts only after coordination with the macOS owner.

Audit-specific implementation points:

- Current `server/package.json` is a symlink to root `package.json`. Server and
  agent are installation roles sharing a distribution, not two independent packages.
  Receipts must retain that package when either role remains installed.
- A TUI installation includes the CLI; upgrades preserve the extra and uninstall
  handles that dependency explicitly.
- Release manifests contain immutable URLs, SHA-256, size, commit, component version,
  OS/architecture, runtime requirements, and tested API compatibility metadata.
  Resolve `latest` once before installation. Validate archive extraction paths.
- `uv tool install` does not consume repository `uv.lock`. Publish/export matching
  runtime constraints when promising a reproducible Python release installation.
- Existing macOS app packaging is host-architecture, ad-hoc signed, and hardcodes a
  version. Release packaging must supply metadata and signing/notarization evidence;
  an end-user app installation uses prebuilt artifacts rather than a Swift build.
- Current `coleo web` proxy uses ordinary fetch for `/ws` and lacks `/uploads`
  forwarding. Treat production proxy repair as an explicit separate integration
  task; the installed web host provides same-origin browser access by proxying
  to the pure API backend.

Acceptance:

- Clean temporary HOME/PATH installs for server-only, agent-only, CLI-only, and TUI.
- Required runtime provisioning works when Bun/Python/uv are initially absent in
   supported clean-host test images; tests use controlled artifacts.
- Existing unrelated runtimes/configuration remain intact.
- CLI-to-TUI upgrade and pinned-version reinstall are idempotent.
- Failed download/checksum/install keeps the previous installed version usable.
- Client install works independently of server installation; server install works
   independently of client packages and web artifacts.
- Shell quoting handles spaces in paths; no secret values appear in logs.
- Installer reports exact executable paths, version, connection next steps, and
   the upgrade/uninstall commands for that installation.

## D — API command migrations

Create a per-family compatibility table before coding: old command, flags,
defaults, source of data, side effects, target Python command, API endpoint,
pagination/stream behavior, and output/exit-code changes. Compare actual source,
not just help text. Submit missing server functionality as API service changes.

| Batch | Work | Required acceptance |
| --- | --- | --- |
| D1 | Remote agent listing; arm list/detail/spawn/kill/prompt/todos/recover/remove/cleanup; explicit local log distinctions | Encoded IDs, host selection, one-shot writes, original option mapping, partial bulk failures |
| D2 | Activity list/transcript/search/tail and arm transcript views | Filters, pagination/cursors, stable event order, deduplication, interruption, bounded polling |
| D3 | Mail inbox/read/send and existing named Inbox integration | Explicit read mutations, complete bodies, ambiguous reference handling, attachments/recipient semantics as applicable |
| D4 | Discovery list/resolve/history and API-managed settings | Status/filter parity, mutation semantics, validated payloads, source-specific failures |

API starting points for the D assignments:

- D1: `/api/agents`, `/api/agents/:id/arms`, `/api/arms`, arm detail plus
  `/spawn`, `/kill`, `/prompt`, `/recover`, `/todos`, `/messages`, `/events` routes.
- D2: `/api/activity`, `/api/activity/transcript`, `/api/activity/stats`, and
  `POST /api/search`. Inspect response contracts before selecting stream cursors.
- D3: `/api/mail/inbox`, `/api/mail/inbox/:id`, `/api/mail/send`, folder/message
  routes and flag/archive/delete actions in `server/src/api/routes/mail.ts`.
- D4: `/api/discoveries` and detail/PATCH/search/stats, `/api/config` subroutes.
  Resolve-by-title, history, and summarization need their own parity decisions.

These route families are implementation references, not proof of exact legacy
flag/output parity. Track every old operation in the per-family table.

Already implemented task/bug CSV, discussions, plan maintenance, Inbox, and brain
API controls still receive command/flag parity review before old implementations
are retired. API-based brain start/stop remain distinct from daemon lifecycle.

Local harness debugging, git workflow helpers, report-file backfill, and discovery
summarizer diagnostics receive an explicit disposition: operator tool, server-owned
API job, or documented retirement. Implementing a generic HTTP passthrough does
not count as command migration.

Compatibility cutover is integrator-owned: after the family passes installed-client
tests, remove its old Bun business logic/registration or replace it with a temporary
error naming the exact client replacement. Preserve reusable server services and
their tests even when their former CLI callers are removed.

## Integration and verification

The integrator owns root `package.json`, `pyproject.toml`, `mise.toml`, lockfiles,
central CLI registration, API capability route registration, and final docs navigation.
Avoid concurrent edits to these files by receiving patches from track owners.

At I1:

1. Build and install artifacts into temporary tool roots outside the checkout.
2. Verify each executable's help/version and that its documented commands resolve.
3. Start owned fixture services and connect an Arm Host plus Python client.
4. Verify named profile switching between two fixture servers and inspect request
   logs to prove the selected target receives each operation.
5. Verify the API never serves UI assets and installed web hosting proxies correctly.
6. Run root type checking, relevant Bun tests, Python integration suite, shellcheck,
   web tests/build when touched, and docs build.

Integrator prerequisite corrections discovered in audit:

- CI jobs that use filtered server-only setup and then run web lint/build must
  explicitly install web dependencies first. Audit `.github/workflows/ci.yml`
  and npm publishing jobs before using them as release gates.
- `dev:core`/`dev:all` currently launch a background API despite foreground wording;
  align them with the new `run` contract and update instructions together.
- Verify runtime pin consistency across `packageManager`, mise, containers, and
  CI. Release manifests record tested pins rather than unconstrained `latest`.
- Validate bundled template/resource resolution with all new dist entry points.
- Correct web-hosting documentation if a deployment path's proxy lacks upgrades
  or uploads support; initial release examples use verified hosting paths.

Release matrix: macOS/Linux server and agent; Python CLI/TUI on explicitly tested
platforms; macOS app on macOS; browser client on supported browsers. Windows
service/background-process support must be tested and documented before advertised.

Record commands, outputs, platform/runtime versions, artifact versions, and remaining
unsupported cases in `.project/reports/component-cli-installation-verification.md`.
Do not run smoke mutations against the user's active server.

## Agent handoff template

```text
Implement track <A|B|C|D batch> from .project/plans/component-cli-installation-plan.md.
Baseline: <commit/worktree>. Owned files: <explicit list>. Shared files are integrator-owned.
Read applicable AGENTS.md and inspect existing changes first. Preserve unrelated work.
Follow the shared executable, configuration, output, and compatibility contracts.
Implement and run the acceptance checks for this track. Use owned fixtures/temp paths.
Do not publish releases or change the default `coleo` behavior as part of this track.
Return: changed files, tests/evidence, requested shared-file patches, unresolved
integration dependencies, and a concise conventional-commit summary.
```

## Definition of done

- Users can install server, agent, CLI, TUI, web, and available macOS artifacts through
  documented component-specific steps with accurate final messaging.
- Operator CLIs manage local services; migrated workspace commands operate through
  the API selected by the client configuration resolver.
- Every original command has a tested replacement, a retained local role, or a
  documented retirement and migration message.
- Package/installer paths have one owner per executable and preserve configurations
  on upgrade. Release docs identify current behavior separately from planned work.
- Clean-host, installed-artifact, API/PTY, build, and documentation checks pass.
