# Docker Guide

Use Docker when you want Coleo running as a self-hosted service instead of as local foreground processes.

## Choose the Docker Path

### Local or private host

This is the default and recommended starting point.
It runs:

- `observatory` (web UI + API)
- `brain`
- `nats`
- `qdrant`

Bring it up with:

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

This is the right mode for:

- local Docker or OrbStack testing on a laptop or Mac mini
- a home server used only from the same machine
- a home server reached over LAN, Tailscale, or another VPN

For LAN or VPN access, keep the same Compose file and set:

```bash
COLEO_BIND_HOST=0.0.0.0
COLEO_PUBLIC_ORIGIN=http://<your-private-hostname-or-tailscale-name>
```

Examples:

- `COLEO_PUBLIC_ORIGIN=http://macmini.local`
- `COLEO_PUBLIC_ORIGIN=http://macmini.tailnet-name.ts.net`

### Public internet exposure

Only add the edge overlay when you want public DNS hostnames, TLS termination, and browser auth in front of the Observatory/API.

```bash
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  -f deploy/self-host/docker-compose.hosting.edge.example.yml \
  up -d --build
```

Before using the edge overlay, set at least:

- `COLEO_DOMAIN`
- `AUTH_DOMAIN`
- `ACME_EMAIL`
- `AUTH_ADMIN_PASSWORD_HASH`

The edge overlay adds:

- Traefik
- Authelia
- optional Tailscale sidecar integration

Most home-server users should use the base stack over Tailscale or another VPN before introducing the public edge overlay.

## Bootstrap Behavior

`./deploy/self-host/bin/bootstrap-host.sh` is safe to rerun.

It will:

- create `deploy/self-host/.env.hosting` if missing
- fill missing local/private defaults
- generate missing secrets
- preserve existing `COLEO_API_KEY` and `COLEO_BOOTSTRAP_TOKEN`
- render optional edge config templates if `envsubst` is available

## Initialization

The hosting image does not run `coleo init` during image build.
Initialize runtime state on the host where you want persistent Coleo data to live:

```bash
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  exec observatory coleo init --dir /home/coleo/.coleo --non-interactive
```

## What Docker Gives You

The Docker path is best when you want:

- a stable local or home-server service
- one command to bring up the UI, API, brain, and NATS together
- a clean path to later public exposure with Traefik and Authelia

If you prefer to run Coleo directly from your terminal instead, use the non-Docker path in [Getting Started](/guides/getting-started).
