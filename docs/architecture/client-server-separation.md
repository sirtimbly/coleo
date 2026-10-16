---
title: Server and clients
description: Run the Coleo server, connect clients, and manage server and Arm Host processes.
---

# Server and clients

Coleo consists of a server, a brain process, Arm Hosts, and user clients. The
server exposes the API and stores application data. The brain coordinates work.
Arm Hosts run coding agents. Clients connect to the server to display data and
submit actions.

These components can run on one computer or across several computers. A client
selects its server by URL. The operator CLI manages processes on the computer
where that CLI command runs.

## Components

| Component | Purpose | How you use it |
| --- | --- | --- |
| API server | Stores tasks, bugs, messages, and application state; handles client requests | Start and manage it with the Bun operator CLI |
| Brain | Plans and coordinates work using server state | Run it as a service alongside the API server |
| Arm Host | Runs coding-agent processes and provides access to their workspace | Start an agent service on each computer that will execute work |
| Python CLI | Queries server data and submits actions; produces Rich text or JSON | Run `coleo-client` with a command and options |
| Python TUI | Provides a tabbed terminal workspace | Run `coleo-client tui` |
| Web client | Provides the browser workspace | Open its URL in a browser |
| macOS client | Provides a native desktop workspace | Launch the macOS app and configure its server connection |

The server and operator CLI use Bun. The Python CLI uses Python, HTTPX, and Rich;
the TUI adds Textual and WebSocket support. Each client is installed separately.

## Run the server

From a repository checkout on the computer that will host the API:

```sh
mise run setup
mise run server
```

`setup` installs the server/operator dependencies. `server` starts the API as a
background service. Its default URL is `http://127.0.0.1:8080`.

With the Bun package installed, use `coleo-server` to manage that service:

```sh
coleo-server status
coleo-server logs
coleo-server restart
coleo-server stop
```

Run those commands on the server host, either in a local terminal or through SSH.
They manage the service registered in that host's Coleo configuration.

Start the brain on the host where it will run:

```sh
coleo-server brain start
```

For foreground development from a checkout, `mise run brain` runs the brain in the
terminal. `mise run dev:core` runs the API and brain together in the foreground.

### Server connection settings

Set the server's listening address, API key, and NATS connection in the environment
used to start the server and brain processes:

```sh
export COLEO_API_HOST=0.0.0.0
export COLEO_API_PORT=8080
export COLEO_API_KEY='your-api-key'
export COLEO_NATS_URL=nats://nats.example.internal:4222
export COLEO_NATS_TOKEN='your-nats-token'
coleo-server start
```

Replace the example hostnames and credentials with your deployment's values.
`COLEO_API_KEY` is the HTTP API credential. `COLEO_NATS_TOKEN` is a separate
credential configured on the NATS service. Set the NATS token when that service
uses token authentication. The API server, brain, and Arm Hosts connect to the
same NATS service.

| Variable | Purpose | Default |
| --- | --- | --- |
| `COLEO_API_HOST` | Address on which the API listens | `0.0.0.0` |
| `COLEO_API_PORT` | API listening port | `8080` |
| `COLEO_API_KEY` | API authentication key | Generated development key |
| `COLEO_NATS_URL` | Full URL of the NATS service | Derived from NATS host and port |
| `COLEO_NATS_HOST` | NATS host when constructing a URL | `127.0.0.1` |
| `COLEO_NATS_PORT` | NATS client port | `4222` |
| `COLEO_NATS_TOKEN` | NATS authentication token | Unset |

With `COLEO_NATS_URL` unset, `coleo-server run` starts or reuses a local NATS service.
With a URL set, it connects to that existing service. The repository's mise
configuration selects port **4223** for local NATS and **8223** for NATS monitoring.
Use port 4223 when connecting an Arm Host to that checkout's NATS service.

`0.0.0.0` is a listening address. Clients use the server's reachable hostname or IP
address, such as `http://coleo.example.internal:8080`, or its HTTPS reverse-proxy URL.

## Run an Arm Host

On a computer that will execute coding-agent work, configure its server and
transport connection, then start the agent service:

```sh
coleo-agent configure --help
coleo-agent start
```

The Arm Host can run on the API server's computer or on a separate computer. It
launches and manages the coding-agent processes assigned to that host.

Use a stable agent ID and runtime directory across restarts. The host records its
launched arms in owner-only files and recovers them only when runtime, agent ID,
workspace, and live process identity match. Arms started by older versions without
these ownership records are not automatically adopted. Stop or migrate those arms
through their original host before replacing it.

Starting an Arm Host is a process-management operation. Requesting that the server
spawn, prompt, or stop an individual arm is an API operation. The server routes
that request to the appropriate Arm Host.

### Arm Host connection settings

Run these commands on the Arm Host computer:

```sh
export COLEO_NATS_URL=nats://nats.example.internal:4222
export COLEO_NATS_TOKEN='your-nats-token'
export COLEO_AGENT_WORKDIR=/srv/projects/my-project
export COLEO_DIR=/srv/coleo/agent-state

# HTTP connection for API-based operator commands and tools on this host:
export COLEO_API_URL=https://coleo.example.com
export COLEO_API_KEY='your-api-key'

coleo-agent start --id build-host-1 --max-arms 10
```

| Setting | Purpose |
| --- | --- |
| `COLEO_NATS_URL` | Coordination connection to the NATS service used by the server |
| `COLEO_NATS_TOKEN` | Token for that NATS service, when configured |
| `COLEO_AGENT_WORKDIR` | Workspace directory on the Arm Host; defaults to the command's working directory |
| `COLEO_DIR` | Coleo runtime/configuration directory on the Arm Host |
| `COLEO_API_URL` | HTTP API URL for API-based commands and tools running on the host |
| `COLEO_API_KEY` | HTTP API key for those commands and tools |
| `--id` | Agent ID; defaults to an ID generated from the hostname |

`coleo-agent start` uses NATS to register and receive work. Its `--nats-url` flag
takes precedence over `COLEO_NATS_URL`. Without either, it constructs the URL from
`COLEO_NATS_HOST` and `COLEO_NATS_PORT`.

For server-side workspace operations routed through an Arm Host, configure these
variables on the **API server**:

```sh
export COLEO_REMOTE_ARMS_ONLY=1
export COLEO_WORKSPACE_AGENT_ID=build-host-1
export COLEO_REMOTE_WORKDIR=/srv/projects/my-project
```

Set `COLEO_WORKSPACE_AGENT_ID` to the ID passed to `coleo-agent start --id` and
`COLEO_REMOTE_WORKDIR` to the workspace path on that host. `COLEO_PROJECT_DIR`
takes precedence over `COLEO_REMOTE_WORKDIR` when selecting the server workspace.

## Install and connect the Python client

From a checkout on the computer where you want to use the client, choose one:

```sh
mise run setup:cli    # Rich CLI and JSON output
mise run setup:tui    # CLI plus the tabbed terminal workspace
```

Mise supplies uv for these tasks. uv installs Python 3.12 and the selected client
dependencies in an isolated tool environment. Both profiles provide the
`coleo-client` command and its `coleo-inbox` compatibility alias.

Select a server and supply its API key when authentication is enabled:

```sh
export COLEO_API_URL=http://127.0.0.1:8080
export COLEO_API_KEY=your-api-key

coleo-client tasks --status blocked
coleo-client bugs --json
coleo-client dashboard --json
coleo-client tui tasks
```

Use `127.0.0.1` when the API runs on the same computer as the client. For a remote
server, set `COLEO_API_URL` to its reachable HTTP or HTTPS address.

| Variable | Purpose | Default |
| --- | --- | --- |
| `COLEO_API_URL` | Full server URL, including a non-default port when needed | `http://127.0.0.1:8080` |
| `COLEO_API_KEY` | API key matching the selected server | Empty |

The Python CLI and TUI use the same connection settings. Set the full URL in
`COLEO_API_URL`; host/port composition and the `COLEO_API_TOKEN` alias are features
of the Bun CLI. Python reads the exported environment directly. To load a trusted
shell-format configuration file before running it:

```sh
set -a
. "$HOME/.config/coleo/connection.env"
set +a
coleo-client dashboard --json
```

Create that file with your `COLEO_API_URL` and `COLEO_API_KEY` assignments.

For saved server connections:

```sh
coleo-client connect https://coleo.example.com --name production --prompt-key
coleo-client connections
coleo-client use production
coleo-client doctor --json
coleo-client --connection production tasks
```

`connect` checks access before saving and selecting the connection. Add
`--save-only` to configure a server while offline. `use` changes the saved selection
without a network request. `--connection` selects a profile for one invocation;
`COLEO_CONNECTION` selects it through the environment. `--server` overrides its URL.
Connection values resolve in order: flags, exported environment, saved connection,
then defaults. `--profile` remains the Inbox query profile, not the server selection.

Connections are stored in `connections.json` in the Python client's configuration
directory (`COLEO_CONFIG_DIR` overrides that directory). Saved keys use an
owner-readable file; connection listings and diagnostics redact them. The optional
TUI uses the same resolved connection as one-shot commands.

The Python client supports Inbox, Tasks, Bugs, Brain, Dashboard, mail, discoveries,
arm configuration, and status reports. Task and bug
commands include CSV import/export and editor workflows. Task commands also
include discussions and plan maintenance. Run `coleo-client tasks --help` for
the available operations and options.

Client requests operate on the selected server's data. For example,
`coleo-client tasks sync` reads plans from the server's configured workspace.
That workspace is selected by `COLEO_PROJECT_DIR`, then `COLEO_REMOTE_WORKDIR`,
then the server process's working directory. A configured remote Arm Host can
provide workspace access.

## Connect the macOS client

The macOS app uses `COLEO_API_URL` and `COLEO_API_KEY` from its launch environment.
These values take precedence over the saved connection settings in the app.
The default URL is `http://127.0.0.1:8080`.

From a checkout, launch it with:

```sh
COLEO_API_URL=https://coleo.example.com \
COLEO_API_KEY='your-api-key' \
mise run client:mac:run
```

For an app launched through Finder, enter the server URL and API key in the app's
connection settings. Shell exports apply to processes launched from that shell;
Finder-launched apps use their own launch environment and saved settings.

## Run the web client

The web client is a React/Vite application in `clients/web`. It communicates with
the server through HTTP and WebSocket connections.

### Development

From the repository root:

```sh
mise run setup:web
COLEO_API_URL=http://127.0.0.1:8080 mise run web:dev
```

Open `http://localhost:5173` in a browser. The Vite development server forwards
`/api`, `/ws`, and `/uploads` requests to the configured API URL.

`COLEO_API_URL` configures the Vite proxy process. If it is unset, the proxy uses
`COLEO_API_HOST` and `COLEO_API_PORT`, defaulting to `127.0.0.1:8080`. Set the API
key in the web app's **Settings → API Key** field; the browser stores it for that
web origin and sends it in API requests. Browser authentication uses that saved
key or the deployment's session authentication, rather than the shell's
`COLEO_API_KEY`.

### Production

Install the optional web component and launch it with the client connection:

```sh
coleo-install install web --version VERSION
coleo-client connect https://coleo.example.com --name production --prompt-key
coleo-client --connection production web
```

`coleo-client web` runs the installed web host in the foreground. It serves the
browser application and proxies API, uploads, and WebSocket requests to the
selected server. The selected API credential is passed to the host process through
its environment. The default listening address is `127.0.0.1:3000`; `--host` and
`--port` select a different local address. Stop the host with Ctrl+C.

The API server exposes API and WebSocket endpoints only. Its root URL and browser
routes return 404. Install and launch the web component on the host that should
serve the browser interface; changing an API server environment variable cannot
enable UI hosting.

For a source-checkout build of the same web component:

```sh
bun run web:build
COLEO_API_URL=http://127.0.0.1:8080 bun clients/web/dist/host.js
```

The build produces browser assets and the separate host bundle in `clients/web/dist`.

## Apply connection changes

Set environment variables before starting each component. Restart a running
server, Arm Host, or web development process to apply changed connection values;
relaunch the TUI or macOS app to apply changed launch-environment values. Each
new CLI invocation reads its environment at startup.

For managed services, put the variables in the service's environment configuration.
The Bun operator CLI also loads the first available environment file from the
Coleo directory's `.env`, the project directory's `.env`, or the working
directory's `.env`. Existing nonempty environment values take precedence.

## Choose the command for the operation

| Operation | Command interface | Target |
| --- | --- | --- |
| Start or stop the API service | `coleo-server …` | Service on the host running the command |
| Start an Arm Host | `coleo-agent start` | Agent process on the host running the command |
| Start or stop a brain daemon | `coleo-server brain start/stop` | Brain process on the host running the command |
| Read tasks or import task CSV | `coleo-client tasks …` | Data on the selected API server |
| Control brain operation through the API | `coleo-client brain start/stop` | Brain control exposed by the selected server |
| Synchronize tasks from plans | `coleo-client tasks sync` | Workspace configured for the selected server |
| Open the terminal workspace | `coleo-client tui` | Client session connected to the selected server |
| Serve the installed browser workspace | `coleo-client web` | Web host connected to the selected server |

Migrated Bun domain commands print their Python-client replacements. The
[workspace client guide](../guides/workspace-client) documents installation and
the release transition.

## Repository and build tasks

```text
server/src/        API, brain, agent runtime, operator CLI
clients/web/       React/Vite browser workspace
clients/python/    Rich CLI and Textual TUI
clients/macos/     Native macOS workspace
```

The server implements application rules, storage, and state changes. Clients
implement presentation and submit actions through the API. The web source also
shares TypeScript types and pure presentation helpers with `server/src`.
`src/web` is a compatibility symlink to the web client source.

| Task | Result |
| --- | --- |
| `mise run setup` | Installs root server/operator dependencies and contributor tooling |
| `mise run setup:cli` | Installs the Python CLI tool |
| `mise run setup:tui` | Installs the Python CLI with TUI dependencies |
| `mise run setup:web` | Installs web workspace dependencies |
| `mise run setup:all` | Installs all server and client development dependencies |
| `bun run build` | Builds the server/operator distribution |
| `bun run web:build` | Builds browser assets and their independent host in `clients/web/dist` |
| `bun run build:with-web` | Builds the server and web component as separate artifacts |

Mise installs tools for the tasks that use them: Bun for the server, uv/Python for
Python client tasks, and shellcheck for shell linting.
