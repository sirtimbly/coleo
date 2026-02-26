# Self-Hosting Blueprint (Traefik + Tailscale + Passkey-capable Auth)

This folder provides a production-friendly bootstrap for new hosts that need Coleo plus its data services:

- Coleo API and Brain services
- NATS (JetStream)
- Qdrant
- Traefik edge proxy with automatic TLS
- Authelia authentication portal (supports WebAuthn/passkeys)
- Optional Tailscale ingress profile

## Why this design

1. **Simple first boot:** one script generates secrets, renders auth/proxy config, and prints a setup token.
2. **No pair-code UX:** users sign in through a standard browser auth flow (Authelia + passkey).
3. **Operator recovery:** admin reset remains possible by replacing bootstrap env vars and restarting.
4. **Cloud-provider neutral:** works on VPS/container hosts where Docker Compose is available.

## Quick start

```bash
# 1) Copy and fill base values (domains, email, API keys)
cp deploy/self-host/.env.hosting.example deploy/self-host/.env.hosting

# 2) Generate secure defaults + render templates
./deploy/self-host/bin/bootstrap-host.sh

# 3) Bring up the stack
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  up -d --build
```

## Initialization model (`.coleo` state)

This deployment **does not run `coleo init` inside the image build**.
Initialization should happen on the runtime where you want persistent Coleo state to live.

- If API + Brain run on this host, run init in the running container once and keep the split `coleo-*` volumes (especially `coleo-root`, `coleo-db`, and `coleo-mail`).
- If you split deployment (for example laptop arms + remote API/observatory), initialize on each runtime that owns its own `.coleo` state.

```bash
# Example: initialize runtime state on the hosting stack
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  exec coleo coleo init --dir /home/coleo/.coleo --non-interactive
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

This keeps hosted API dependencies explicit while still preserving compatibility with components that read `COLEO_DIR`.

## Authentication model

- `COLEO_BOOTSTRAP_TOKEN` is generated and printed during bootstrap.
- Traefik protects Coleo behind Authelia forward auth.
- Authelia supports WebAuthn so the installer can register a passkey and use that for future logins.
- `AUTH_ADMIN_PASSWORD_HASH` is intentionally retained for emergency recovery/reset.

### Admin reset path

1. Generate a new argon2 hash for a replacement admin password.
2. Update `AUTH_ADMIN_PASSWORD_HASH` and optionally `AUTH_ADMIN_EMAIL` in `.env.hosting`.
3. Re-run `./deploy/self-host/bin/bootstrap-host.sh`.
4. Restart auth and edge services:

```bash
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  up -d authelia traefik
```

## Reverse proxy options

- **Default:** Traefik on ports `80/443` with ACME TLS.
- **Optional private ingress:** enable Tailscale profile:

```bash
docker compose \
  --env-file deploy/self-host/.env.hosting \
  -f deploy/self-host/docker-compose.hosting.yml \
  --profile tailscale up -d
```

Use Tailscale when you want private mesh access without opening the app publicly.

## Notes

- Keep `.env.hosting` out of source control.
- If `envsubst` is missing, install `gettext` and rerun bootstrap.
- This setup intentionally avoids client/server pairing codes.
