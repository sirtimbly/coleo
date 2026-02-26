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
