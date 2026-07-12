# Self-Hosting Blueprint

This folder provides a production-friendly bootstrap for new hosts that need Coleo plus its data services:

- Observatory web app and API
- Brain service
- OpenCode arm agent for headless hosted arms
- NATS (JetStream)
- Qdrant
- Optional edge overlay for Traefik, Authelia, and Tailscale

## Why this design

1. **Simple default stack:** direct web/API ports with no proxy or auth middleware required.
2. **Optional edge layer:** reverse proxy and passkey auth live in a separate example overlay.
3. **Safe bootstrap:** rerunning bootstrap preserves existing API/bootstrap secrets instead of silently rotating them.
4. **Cloud-provider neutral:** works on VPS/container hosts where Docker Compose is available.

## Quick start

```bash
# 1) Copy and fill base values
cp deploy/self-host/.env.hosting.example deploy/self-host/.env.hosting

# 2) Generate secure defaults
./deploy/self-host/bin/bootstrap-host.sh

# 3) Bring up the stack
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  up -d --build
```

After startup:
- Observatory web app: `http://localhost`
- API: `http://localhost:8080/api/health`
- NATS: `nats://localhost:4222`

Defaults in `.env.hosting`:
- `COLEO_BIND_HOST=127.0.0.1`
- `COLEO_PUBLIC_ORIGIN=http://localhost`
- `COLEO_WEB_PORT=80`

For a hosted OpenCode workspace, also set:

```bash
COLEO_GIT_REPO_URL=https://github.com/your-org/your-repo.git
COLEO_GIT_REF=main
OPENCODE_API_KEY=<your-opencode-key>
GITHUB_TOKEN=<optional-token-for-private-repos>
```

The image includes Bun, Node/npm, Git/OpenSSH, common CLI/dev tools, and the current `opencode-ai` CLI. On startup the arm-agent container clones `COLEO_GIT_REPO_URL` into `/home/coleo/projects/app` when it is set, then starts `coleo agent start` from that checkout so the web UI can spawn `opencode-api` arms against the repository.

Files in this folder:
- `docker-compose.hosting.yml`: default local/private stack
- `docker-compose.hosting.edge.example.yml`: optional public edge overlay
- `bin/bootstrap-host.sh`: idempotent secret/bootstrap helper
- `authelia/*`, `traefik/*`, `tailscale/*`: templates/assets used only when you adopt the edge overlay

## Deployment stages

### 1. Local machine

Use the defaults exactly as generated:

- `COLEO_BIND_HOST=127.0.0.1`
- `COLEO_PUBLIC_ORIGIN=http://localhost`

This is the right mode for:

- A Mac mini or laptop running the stack for personal use
- Local Docker/OrbStack testing
- Development before you decide how you want remote access to work

### 2. Home server over LAN, Tailscale, or another VPN

For private remote access without public internet exposure, keep the base Compose file and open the stack on the host interface:

```bash
COLEO_BIND_HOST=0.0.0.0
COLEO_PUBLIC_ORIGIN=http://<your-private-hostname-or-tailscale-name>
```

Examples:

- `COLEO_PUBLIC_ORIGIN=http://macmini.local`
- `COLEO_PUBLIC_ORIGIN=http://macmini.tailnet-name.ts.net`

Recommended approach:

- Run Tailscale or your VPN on the host machine
- Keep using `docker-compose.hosting.yml`
- Do not add Traefik or Authelia unless you need public internet exposure
- Set `COLEO_BIND_HOST=0.0.0.0` and point `COLEO_PUBLIC_ORIGIN` at your LAN hostname or Tailscale/MagicDNS name

### 3. Public internet exposure

Only add the edge overlay when you want TLS, hostname routing, and browser auth on the public internet.

## Initialization model (`.coleo` state)

This deployment **does not run `coleo init` inside the image build**.
By default, the container entrypoint runs `coleo init --non-interactive` on first startup when `/home/coleo/.coleo/config.toml` is missing. Initialization should happen on the runtime where you want persistent Coleo state to live.

- If API + Brain run on this host, run init in the running container once and keep the split `coleo-*` volumes (especially `coleo-root`, `coleo-db`, and `coleo-mail`).
- If you split deployment (for example laptop arms + remote API/observatory), initialize on each runtime that owns its own `.coleo` state.

```bash
# Example: initialize runtime state on the hosting stack
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  exec observatory coleo init --dir /home/coleo/.coleo --non-interactive
```

### Split persistence layout for hosted API/brain

The Compose profile now separates `.coleo` into dedicated volumes so API/brain dependencies can be managed independently:

- `coleo-root`: root metadata (`config.toml`, `.env`, wrapper files)
- `coleo-db`: SQLite database at `/home/coleo/.coleo/db/coleo.db`
- `coleo-mail`: Maildir state
- `coleo-state`: runtime proposal/task/arm state
- `coleo-logs`: server and arm logs
- `coleo-arms`: arm config files
- `coleo-mcp`: generated MCP manifests
- `coleo-projects`: hosted Git checkout(s), including `/home/coleo/projects/app`

This keeps hosted API dependencies explicit while still preserving compatibility with components that read `COLEO_DIR`.

> Note: the stack intentionally avoids a Qdrant container healthcheck because the upstream Qdrant image does not ship curl/wget, which can create false `unhealthy` states on healthy containers. Service startup ordering uses `service_started` for Qdrant.

## Optional edge overlay

If you want public internet exposure with TLS and passkey-capable auth, layer in the example overlay:

```bash
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  -f deploy/self-host/docker-compose.hosting.edge.example.yml \
  up -d --build
```

Recommended when using the edge overlay:
- Keep `COLEO_BIND_HOST=127.0.0.1` so direct API/web ports stay loopback-only.
- Set `COLEO_DOMAIN`, `AUTH_DOMAIN`, and `ACME_EMAIL`.
- Keep the generated Authelia secrets in `.env.hosting`.
- Set `AUTH_ADMIN_PASSWORD_HASH` before starting Authelia.

The edge example contains:
- Traefik with ACME TLS on `80/443`
- Authelia forward-auth with WebAuthn/passkeys
- Optional Tailscale sidecar profile for advanced/private ingress cases

Most home-server users should prefer host-level Tailscale or another VPN with the base stack before introducing the edge overlay.

### Bootstrap behavior

`./deploy/self-host/bin/bootstrap-host.sh` is safe to rerun.

It will:
- create `.env.hosting` from the example if missing
- fill missing defaults such as `COLEO_BIND_HOST`, `COLEO_WEB_PORT`, and `COLEO_PUBLIC_ORIGIN`
- generate secrets only when the value is missing or still a placeholder
- re-render Authelia and Tailscale config templates if `envsubst` is available

It will not:
- rotate an existing `COLEO_API_KEY`
- rotate an existing `COLEO_BOOTSTRAP_TOKEN`
- force you onto the Traefik/Authelia stack

### Admin reset path

1. Generate a new argon2 hash for a replacement admin password.
2. Update `AUTH_ADMIN_PASSWORD_HASH` and optionally `AUTH_ADMIN_EMAIL` in `.env.hosting`.
3. Re-run `./deploy/self-host/bin/bootstrap-host.sh`.
4. Restart auth and edge services:

```bash
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  -f deploy/self-host/docker-compose.hosting.edge.example.yml \
  up -d authelia traefik
```

## Notes

- Keep `.env.hosting` out of source control.
- If `envsubst` is missing, install `gettext` and rerun bootstrap.
- This setup intentionally avoids client/server pairing codes.
