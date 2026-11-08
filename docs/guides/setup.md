---
title: Set up Coleo
description: Run the setup wizard, connect your preferred client, and wait for central service readiness.
---

# Set up Coleo

`coleo-ops init` configures a local workspace, connects a client to an existing
server, or adds an Arm Host. It preserves existing runtime files and records its
progress so you can resume after fixing a failed check. `setup` remains an alias
for `init`.

## Install the operations tool

For a release containing `coleo-ops`, use the [component installer](./installation):

```sh
coleo-install install ops --version VERSION
coleo-ops init
```

Replace `VERSION` with the release version. The `ops` component includes its
private Bun runtime and operator implementation; it does not start services or
install a user client until you run setup. Older releases without `dist/ops.js`
cannot provide this component. Setup installs missing selected clients from its
matching release; use `--release VERSION` and `--prefix PATH` to customize this.

From a source checkout:

```sh
bun run setup
bun run server/src/cli/ops.ts init
```

For source development, install the CLI and any optional clients separately if
there is no matching published release yet. The CLI is required for every setup
role, including an Arm Host; standalone component lifecycle commands remain
available independently of the wizard.

When running from a linked Coleo checkout without `coleo-install`, selecting web
uses that checkout's web build. If assets are missing, the wizard runs
`bun run web:build` there and creates a launcher at `<runtime>/bin/coleo-web`.
It does not change your global `PATH` or start the web server during installation.
The web handoff prints the complete `COLEO_WEB_EXECUTABLE=... coleo-client web`
command using your saved connection. `COLEO_WEB_EXECUTABLE` can also select an
existing executable explicitly.

## Run everything on this machine

Have a repository directory, Git, and an installed/configured OpenCode harness.
The Brain's provider credential and the OpenCode harness's credentials are
separate. The wizard prompts for the Brain provider/model and a hidden API key;
blank model or credential input keeps the existing/default setting.

```sh
cd /path/to/project
coleo-ops init
```

1. Choose **local**.
2. Select any combination of optional clients from the checklist. **CLI** is
   checked and locked. Use the arrow keys to navigate and Space to toggle
   **Python/Textual**, **web**, and **Swift/macOS**; press Enter to continue. The native app
   is offered on macOS only. Existing selections are retained when resuming.
3. Confirm the workspace and model settings, then review and apply.
4. Wait for the API, Brain, Arm Host, and central service-health checks.

The wizard asks for the repository directory. In a new project it defaults to
your current directory; inside an existing project it discovers the nearest
`.coleo` directory by walking up from your current directory and defaults to that
workspace. You can run `init`, `status`, `doctor`, and `config show` from a nested
source directory without creating a second runtime. `--workspace` explicitly
selects a repository for initialization; `--dir` or `COLEO_DIR` overrides the
runtime location. This directory contains
`operator.json`, setup progress, logs, and runtime assets. New local operator
settings bind the API to loopback; existing settings/environment overrides are
preserved. For a new local installation, setup scans upward from API port **8080**,
NATS port **4222**, and NATS monitoring port **8222**, skipping occupied ports.
It shows the selected ports before confirmation and saves them in `operator.json`
for subsequent starts and resumes. Each runtime keeps its own NATS/JetStream data.
Explicit endpoints and saved ports are retained. An unconfigured NATS URL allows
the server to bootstrap its local broker on the selected port; `--nats-url`
instead selects an externally managed broker. The web handoff also finds an
available port starting at **3000** and includes it in the launch command.

Applying setup starts background services, and Brain polling may call your model
provider. Setup does not submit a demonstration task. If a process is already
running, setup reuses it; configuration changes that require a restart should be
applied with that component's restart command before resuming.

The final summary says **Setup complete** only after the readiness checks pass.
On failure it says **Setup incomplete**, names the failed step, reports whether
service startup was reached, and prints the relevant recovery command. Printed
commands are suggestions; the wizard has not executed them.

### Local and multi-repository workspaces in the web client

Choose **Continue with this workspace** to use existing files or add repositories
later. The workspace root does not need to be a Git repository, and this choice
is saved for that workspace. Setup lists repositories in subfolders, including
Git worktrees. Add or move repositories into the workspace at any time, then use
**Settings → Workspace repositories → Scan for repositories** to refresh the list.
Discovery scans up to four folder levels and 1,000 directories, skipping hidden
folders, dependency/build folders, and symlinks; it reports when the scan is limited.

**Clone a repository** is optional. **Use existing credentials** uses the SSH agent,
SSH configuration, or HTTPS credential helper available to the running Coleo
process. A detected agent does not guarantee access to a particular repository.
You can instead choose a dedicated Coleo SSH key. For a multi-repository workspace,
enter a new destination folder so cloning leaves the other repositories intact.

### Connect your selected interface

The CLI is always installed and its named connection is validated. Optional
clients are installed in addition to it; they do not replace it. For automation:

```sh
coleo-ops init --clients tui,web
```

This selects CLI, Textual, and web together. `--clients cli` selects only the
required CLI and skips the checklist. The older `--client` flag remains an alias;
`none` is no longer an available selection.

- **CLI / Python Textual:** setup validates the API and saves the selected named
  connection through `coleo-client`. It refuses to replace a name pointing at a
  different server. Use `--connection NAME` to choose another name.
- **Web:** setup prints the web-host launch instruction. Start it with
  `COLEO_API_URL` set to your server origin, open the browser, and enter the API
  key in Settings. Browser authentication belongs to the browser/session.
- **Swift/macOS:** open Coleo Workbench and add the server in its Connections
  settings. Native credentials belong to the native client.

For each selected web/native handoff, setup asks you to confirm that you loaded the workspace;
it cannot inspect those clients' private connection stores. Noninteractive setup
leaves these handoffs pending. A generated local API key is stored in
`operator.json` under `values.apiKey`; the wizard prints the file location rather
than exposing the key in terminal output.

## Connect to an existing server

```sh
coleo-ops init --role client --server https://coleo.example.com --connection team
```

Enter the API key in the hidden prompt, or supply `COLEO_API_KEY` in the
environment. Use a server origin without `/api`, query parameters, or embedded
credentials. This path does not start a local Brain, database, or Arm Host.

The selected client stores its own connection. Ops saves nonsecret target
metadata; client-only credentials entered at the prompt are not stored in ops.
Supply `COLEO_API_KEY` again for subsequent ops diagnostics/resume, or enter it
when prompted during setup.

## Add an Arm Host

```sh
coleo-ops --dir /path/to/host-runtime init --role agent \
  --workspace /path/to/repository \
  --server https://coleo.example.com \
  --nats-url tls://broker.example.com:4222
```

Get the HTTP API key and broker credentials from the server operator. API and
NATS credentials authenticate different transports. Setup accepts a hidden NATS
token prompt or `COLEO_NATS_TOKEN`, checks OpenCode availability, starts the host,
and waits for its fresh heartbeat to appear on the central API.

## Understand the final health check

Setup polls the authenticated `/api/operator/health` endpoint and waits for two
consecutive green snapshots in the same API generation. Checks include the full
persisted infrastructure inventory, Brain polling/model access/planning gate,
and Arm Host visibility. Missing or stale observations remain pending.

Qdrant is checked when `COLEO_QDRANT_URL` is explicitly configured on the server.
The indexer is checked when its service is registered. Unconfigured integrations
are shown as skipped; a failed enabled check is not ignored merely because it is
optional. Older API versions without the operator-health endpoint must be
upgraded before they can pass this check.

```sh
coleo-ops doctor
coleo-ops --doctor
coleo-ops doctor --wait --timeout 180
coleo-ops doctor --role client --server https://coleo.example.com --json
```

`doctor` and `--doctor` are equivalent. For an initialized project, doctor repairs
missing launch defaults in the project root `.env` and runtime `.env`, using the
saved workspace, connection name, and web executable. Existing values and
credentials are preserved; conflicting values are reported for correction.
Restart the API server after repairing its project paths. Without `--wait`, doctor reports a
single snapshot. A client can connect successfully while central readiness is
still incomplete; setup reports that distinction rather than declaring success.

`init` writes these defaults for new projects too. From the project root or a
subdirectory, `coleo-server start` discovers the runtime, and `coleo-client web`
selects the project's saved connection and web executable. Explicit flags and
exported environment variables override project defaults. An explicit client
connection bypasses the project's endpoint and credential defaults.

## See what is selected and what needs attention

```sh
coleo-ops status
coleo-ops status --json
```

Status shows the selected workspace, runtime directory, server and its source,
local component processes, and a bounded central readiness snapshot. It lists
the first few blockers and prints a command for further diagnosis. A client-only
target shows central health without treating absent local services as failures.

An uninitialized directory produces an `init` hint without creating files or
probing the default API. Status exits 0 when ready and 1 when initialization or
attention is needed. `doctor --wait` remains the command for waiting on startup
and examining the complete check inventory.

### Explain configuration choices

```sh
coleo-ops config show
coleo-ops config show --show-origin
coleo-ops config show --json
```

These commands inspect effective operator settings without contacting the server
or modifying configuration. `--show-origin` identifies the flag, environment
variable, file and field, or default supplying each value. JSON always includes
origins. API keys and NATS tokens are always redacted, including in JSON.

Runtime selection is `--dir` → `COLEO_DIR` → `COLEO_PROJECT_DIR/.coleo` → nearest enclosing `.coleo` →
current-directory `.coleo`. An explicit `init --workspace PATH` uses that
workspace's `.coleo` instead of upward discovery unless the runtime is overridden.

For the server origin, status, doctor, and config inspection use the same order:
`--server` → exported environment → loaded env file → ops `target.json` →
`operator.json` → loopback with the resolved port. Other operator values retain
their normal flag/environment/env-file/saved/default precedence. The env loader
loads runtime `.env`, then fills missing values from the selected workspace's
`.env`. Exported variables take precedence over both files.

This inspection covers operations settings, not Brain model configuration or
the private settings of your CLI, Python/Textual, Swift, or browser clients.
It does not introduce a new global configuration store.

## Resume and troubleshoot

```sh
coleo-ops --dir /path/to/project/.coleo init --resume
```

Completed steps are checked/reapplied idempotently rather than trusted blindly.
Existing configuration/templates are preserved, healthy processes are reused,
and keys are not regenerated on rerun. The journal contains no credentials.
Repeat installation overrides such as `--prefix` when resuming.

| Result | Next action |
| --- | --- |
| Component could not be verified; installer unavailable | Install that component or change optional selections. Linked checkouts can prepare their web host locally; release installations require the component installer. |
| API unavailable or authentication rejected | Check origin, credential, and server logs. |
| Another workspace is served | Select the correct runtime/port; stop the conflicting service before retrying. |
| OpenCode missing | Install and authenticate OpenCode on the Arm Host. |
| Model or planning gate blocked | Correct the provider settings or project plan; inspect Brain logs. |
| No host heartbeat | Check NATS connection settings and Arm Host logs. |
| Readiness timeout | Fix remaining checks, then use `doctor --wait` or resume with a longer `--timeout`. |
| Setup lock remains after a crash | Confirm no setup process is running before removing `setup.lock` in the runtime directory. |

The deadline defaults to 180 seconds. Timeout exits nonzero and leaves services
and saved progress available for diagnosis. Focused tools remain available:

```sh
coleo-server --dir /path/to/project/.coleo logs
coleo-server --dir /path/to/project/.coleo brain logs
coleo-agent --dir /path/to/project/.coleo logs
```

## Automation

```sh
coleo-ops init --config setup.json --dry-run --json
coleo-ops init --config setup.json --non-interactive --json
```

Example `setup.json`:

```json
{
  "schemaVersion": 1,
  "role": "local",
  "clients": ["cli", "tui"],
  "workspace": "/srv/project",
  "connection": "local"
}
```

Optional fields: `server`, `natsUrl`, `provider`, and `model`. Credentials belong
in `COLEO_API_KEY`, `COLEO_NATS_TOKEN`, and `COLEO_BRAIN_API_KEY` (or
`OPENAI_API_KEY`), not the JSON file or command arguments. Dry-run performs no
writes, downloads, or service startup. JSON results go to stdout; progress goes
to stderr. Success exits 0, operational failure exits 1, command syntax errors
exit 2, and cancellation exits 130.

The `clients` array is additive: CLI is included even when omitted. Legacy
single-`client` configuration and journals are migrated on load, preserving the
optional client and adding CLI where needed.
