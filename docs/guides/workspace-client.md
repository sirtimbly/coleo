---
title: Workspace CLI and TUI
description: Choose an optional terminal client and understand how it fits alongside the Bun server CLI.
---

# Workspace CLI and TUI

Coleo has a **server/operator CLI** and an optional **workspace client**.
Choose the tools you need; running the server does not require Python.

| What you need | Install | Command | Runtime |
| --- | --- | --- | --- |
| Host Coleo, configure services, run agents | Existing `coleo` npm package | `coleo` | Bun |
| Browse and automate Inbox, Tasks, Bugs, Brain, Dashboard | Python workspace client | `coleo-client` | Python 3.12 or 3.13 |
| Interactive terminal workspace with tabs | Python client with `tui` extra | `coleo-client tui` | Python plus Textual |
| Browser interface | Open a running web client; launch one with `coleo-client web` | Browser; separate host process | Install the `web` component on its host |

The Python client connects over HTTP. A remote client's machine does not need Bun
or a local Coleo database. The server still needs Bun. Rich output and JSON are
included in the base Python client; Textual and WebSocket support are optional.

## Install the optional client

### From a checkout with mise

Start with server dependencies only, then add any clients you want:

```sh
mise run setup        # Bun/server dependencies; no Python or web workspace install
mise run server       # start the local API service

# Optional, now or later:
mise run setup:cli    # installs coleo-client with Rich + JSON
mise run setup:tui    # installs/upgrades coleo-client with Textual too
mise run setup:web    # installs web client dependencies
mise run web:dev      # serves the web client on port 5173
```

Mise installs uv only for the Python setup tasks; uv provisions Python 3.12 and
an isolated tool environment. No global Python dependencies are installed.
`setup:cli` and `setup:tui` are alternative installation profiles for the same tool;
running `setup:cli` later replaces the TUI-enabled installation with CLI-only.
If the installed command is not on PATH, run `mise exec uv@latest -- uv tool update-shell`
and reopen your terminal. `setup:all` installs all contributor dependencies instead.

Setup does not launch a client or run an interactive installer after a daemon
starts. These explicit tasks work consistently in a terminal, automation, and CI.

### Without mise

The instructions below install from a Coleo checkout. They do not assume a Python
package has been published to PyPI. Install [uv](https://docs.astral.sh/uv/getting-started/installation/)
first; it manages the client's isolated environment and can download Python.

From the repository root, choose one:

```sh
# CLI only: Rich terminal output and JSON
uv tool install --python 3.12 .

# CLI plus interactive terminal workspace
uv tool install --python 3.12 '.[tui]'
```

If the tool directory is not on PATH, run `uv tool update-shell` and open a new
terminal. Adding the TUI to an existing installation:

```sh
uv tool install --force --python 3.12 '.[tui]'
```

These installs provide `coleo-client` and the compatible `coleo-inbox` alias.
They do **not** install or replace a command named `coleo`.
Use the same install command with `--force` after updating the checkout to upgrade;
`uv tool uninstall coleo-inbox` removes the Python tool and its isolated dependencies.

For contributors running directly from the checkout:

```sh
uv run --no-dev coleo-client modules
uv run --no-dev --extra tui coleo-client tui tasks
```

The development dependency group includes TUI dependencies for tests. Production
CLI-only installs do not include that group.

## Connect and use

```sh
export COLEO_API_URL=http://127.0.0.1:8080
# Set COLEO_API_KEY if the server requires authentication.

coleo-client modules
coleo-client tasks --status blocked
coleo-client bugs --json
coleo-client dashboard --json
coleo-client tui tasks  # requires the tui extra
```

Use `coleo-client tasks --help` for offline domain command help. With no command,
the client loads Inbox; it does not implicitly launch a full-screen interface.
Use `tui` explicitly. The base install returns an installation hint if you request
the TUI without its extra.

## Which command should I use today?

| Job | Workspace client | Existing Bun CLI |
| --- | --- | --- |
| Task and bug browsing, CSV, task discussions | `coleo-client tasks …`, `bugs …` | Existing commands remain available |
| Tabbed terminal workspace | `coleo-client tui` | Use the optional client |
| Brain status/start/stop through the server API | `coleo-client brain …` | Process-management commands retain their existing meaning |
| Initialize installation, run/stop server, configure services | Use the Bun CLI | `coleo init`, `coleo serve …`, `coleo config …` |
| Agent/arm processes, MCP, IMAP, debugging and other operator commands | Use the Bun CLI | `coleo --help` lists supported commands |

**Similar names do not always mean identical behavior.** In particular:

- Python `tasks sync` and `tasks reparse` use the connected **server's workspace**,
  including a configured remote Arm Host. Original Bun commands use their local
  project/database context.
- Python CSV commands modify the connected server through its API. Original Bun
  CSV commands directly access the local Coleo database.
- Python `brain start/stop` call server control endpoints; they do not launch a
  standalone local brain process.
- Python reads `COLEO_API_URL` and `COLEO_API_KEY`; do not assume the Bun CLI's
  project configuration or environment-file discovery carries over automatically.
- Rich text is for people. Use versioned `--json` output for new automation and
  check exit codes: 0 complete, 1 input/request failure, 2 partial results/conflicts.
  Existing scripts should retain their original executable until migrated.

CSV files retain the original format and conflict columns. The newer CSV and
maintenance commands require the corresponding server API routes; upgrade the
server before using them. API failures never silently reroute a write to a local
database or retry it through the old CLI.

## Connections and command ownership

See [Server and clients](../architecture/client-server-separation) for component
roles, process management, and client connection instructions.

Save and select an API server:

```sh
coleo-client connect https://coleo.example.com --name production --prompt-key
coleo-client connections
coleo-client use production
coleo-client --connection production tasks --json
coleo-client doctor --json
```

`connect` saves only after checking access; `--save-only` supports offline setup.
`use`, help, and version work offline. Flags override environment values, which
override saved settings and defaults. `--server URL` selects an endpoint for one
invocation. `COLEO_CONNECTION` selects a saved profile; `COLEO_API_URL` and
`COLEO_API_KEY` override its endpoint and credential. `--profile` still selects a
named-view query profile.

The Bun distribution owns `coleo-server`, `coleo-agent`, and the transitional
`coleo` command. Python owns `coleo-client` and its `coleo-inbox` alias.
Use `coleo-server` for API/brain processes on the host running the command and
`coleo-agent` for that host's Arm Host process. Their `run` command stays in the
foreground; `start` launches a background service. The older `coleo agent start`
retains its foreground meaning.

`doctor` reports the selected endpoint, configuration sources, server workspace
when available, authentication result, and optional TUI availability. Servers that
do not advertise capabilities are reported as unknown. A successful public health
request alone does not establish authenticated access.

See [Component Installation](./installation) for component artifacts and the
installer's versioned install, upgrade, and uninstall commands.
