# Getting Started

This guide starts from the first decision you need to make:

- run Coleo directly from your terminal as local processes
- run Coleo in Docker as a local or home-server service

## Choose Your Runtime Path

### Path A: Local process

Use this when you want to run Coleo directly on your machine with Bun.
This is the best fit for:

- local development
- source checkout workflows
- minimal setup on a laptop or desktop
- people who want to understand the moving parts before containerizing

### Path B: Docker or home server

Use this when you want Coleo running as a service in containers.
This is the best fit for:

- OrbStack or Docker Desktop on a Mac mini or laptop
- a home server on your LAN
- access over Tailscale, WireGuard, or another VPN
- a future path to Traefik and Authelia

See [Docker Guide](/guides/docker) for the container path.

## Prerequisites

For the local-process path:

- [Bun](https://bun.sh/) v1.1+
- Git

For the Docker path:

- Docker or OrbStack

## NATS: How It Works

For local-process development, you do not need to start NATS separately.
If `COLEO_NATS_URL` is unset, `coleo serve` will bootstrap and manage a local standalone
`nats-server` inside the active `.coleo/` directory.

These features depend on NATS + JetStream:

- distributed `ArmAgent` communication
- remote arm spawning across hosts
- stream-backed activity and transcript/event history

If local bootstrap fails or you deliberately disable NATS, Coleo still supports:

- SQLite-backed core state
- local API server
- brain polling loop
- local web UI

### Local process default

For the normal local-process path, just run:

```bash
coleo serve
```

That will:

- install a pinned `nats-server` binary into `.coleo/bin` if needed
- start JetStream-backed local NATS using `.coleo/nats` for state
- point the API server, Brain, and agents at the NATS host and port configured by
  `COLEO_NATS_HOST` and `COLEO_NATS_PORT` (defaults to `nats://127.0.0.1:4222`)

During `coleo init`, Coleo offers to generate available project-specific ports for the API, NATS client, and NATS
monitoring endpoints. This matters when several Coleo projects run on one host: default ports can cause a second
project to reuse the first project's NATS server and JetStream history. Init can merge the generated hosts, ports,
canonical project directory, and a pregenerated API key into `mise.toml`. The API key is plaintext, so do not commit
that file when it contains a real key.

### Manual local NATS control

If you want to install or run that local NATS runtime yourself from a source checkout of this repository, use the helper scripts:

```bash
bun run nats:install
bun run nats:run
```

That installs a pinned official `nats-server` binary into `.coleo/bin` and runs JetStream locally using `.coleo/nats` for state.

Equivalent direct command from the repo root:

```bash
bash bin/run-nats.sh
```

If you installed Coleo globally and do not have the repo checkout, either:

- let `coleo serve` bootstrap local NATS for you
- clone the repo and use the helper scripts from there
- run NATS with Docker
- install the official `nats-server` binary yourself and point `COLEO_NATS_URL` at it

### Docker NATS option

If you are already using Docker, you can run just NATS from the hosting stack:

```bash
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  up -d nats
```

## Path A: Run Coleo as Local Processes

### 1. Install Coleo

#### Install with mise

```bash
mise use bun@latest
MISE_NPM_PACKAGE_MANAGER=bun mise use npm:coleo@latest
mise x -- coleo init --dir ./.coleo
```

#### Install with Bun + npm

```bash
bun install -g coleo
coleo init
```

#### From source

```bash
git clone https://github.com/sirtimbly/coleo
cd coleo
bun install
bun run src/cli/index.ts init
```

If you are developing from source, use `bun run src/cli/index.ts <command>` instead of the global `coleo` binary.

### 2. Initialize state

If you did not already run init during install:

```bash
coleo init
```

This creates `.coleo` state, arm configs, Maildir folders, and local config files.

When an OpenCode-backed arm is spawned, the API refreshes a cached authenticated model catalog
from the local `opencode models` CLI and stores it in `.coleo/cache/opencode-models.json`.
The Observatory uses that cache for OpenCode provider/model dropdowns instead of querying a live
OpenCode server.

### 3. Start the API server

Foreground:

```bash
coleo serve
```

Background daemon:

```bash
coleo serve start
```

Default API URL:

- `http://localhost:8080`
- If `COLEO_NATS_URL` is unset, `coleo serve` will also bring up local NATS at `nats://127.0.0.1:4222`

The startup banner displays the effective API key. If the Observatory asks for a key, copy that
value into the Coleo API key field.

If you want to use a shared or remote NATS server instead, set `COLEO_NATS_URL` before starting
the API server.

### 4. Start the web UI

If you installed a built package:

```bash
coleo web start
```

If you are running from source:

```bash
bun run web:dev
```

Default UI URL:

- `http://localhost:5173`

### 5. Start the brain

```bash
coleo brain run
```

### 6. Spawn an arm

```bash
coleo arm spawn \
  --name dev-arm \
  --harness opencode-api \
  --workdir /absolute/path/to/your-project
```

### 7. Prompt it

```bash
coleo arm prompt dev-arm "Add a dark mode toggle to the settings page"
```

## Path B: Run Coleo in Docker

Use the hosting blueprint under `deploy/self-host/`.

```bash
cp deploy/self-host/.env.hosting.example deploy/self-host/.env.hosting
./deploy/self-host/bin/bootstrap-host.sh

docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  up -d --build
```

Default endpoints:

- Observatory: `http://localhost`
- API health: `http://localhost:8080/api/health`
- NATS: `nats://localhost:4222`

For a home server over LAN, Tailscale, or another VPN, keep the same base Compose file and set:

```bash
COLEO_BIND_HOST=0.0.0.0
COLEO_PUBLIC_ORIGIN=http://<your-private-hostname-or-tailscale-name>
```

If you later want public internet exposure, add:

- `deploy/self-host/docker-compose.hosting.edge.example.yml`

See [Docker Guide](/guides/docker) for the full Docker path.

## Recommended Progression

For most users, the clean progression is:

1. Start with local processes if you are developing from source or just learning the system.
2. Add local NATS only when you want distributed arms or stream-backed observability.
3. Move to the Docker base stack when you want a stable service on a Mac mini or home server.
4. Expose that base stack privately over LAN, Tailscale, or another VPN.
5. Add Traefik and Authelia only when you actually need public internet exposure.
