---
title: IMAP Gateway
description: Connect a private Maildir-backed mailbox to Coleo through the legacy local IMAP gateway.
banner:
  src: /coleo-guide-imap-gateway.png
  alt: A sealed mail capsule travels through a glowing private tunnel between a diver's observatory and an octopus post office with shell-shaped mail cubbies.
  eyebrow: Private Mail Passage
  position: center 48%
---

# IMAP Gateway (Phase 1: Tailscale/Tunnel)

> Legacy/local workflow only: production email flows now require an email gateway integration (Postmark recommended) with a fixed sender and receiver address pair.
>
> For the required gateway setup, see [`/guides/communicate-with-brain#required-email-gateway-postmark-example`](/guides/communicate-with-brain#required-email-gateway-postmark-example).

This guide configures Coleo as a **local IMAP gateway** for Maildir-backed project mailboxes.

Phase 1 is intentionally simple:
- single account
- no TLS in-app
- private network exposure via Tailscale/tunnel only

> Do not expose this directly to the public internet in this phase.

## What this enables

- Add Coleo as a normal IMAP account in iOS Mail.
- Read Brain/Arm communications from your existing Maildir data.
- Keep SQLite + Maildir as the source of truth.

## Run directly

```bash
# Initialize if needed
coleo init

# Generate/show IMAP password
coleo imap password

# Start IMAP server (bind all interfaces for tunnel networking)
coleo imap serve --host 0.0.0.0 --port 1143 --username coleo
```

Then configure your client:
- **Server**: your tunnel/Tailscale hostname
- **Port**: `1143`
- **Security**: none (phase 1, private tunnel only)
- **Username**: `coleo`
- **Password**: value from `coleo imap password`

## Docker stack (Phase 1)

Use `docker-compose.imap-gateway.yml` from the repo root:

```bash
docker compose -f docker-compose.imap-gateway.yml up -d --build
```

This stack:
- initializes Coleo state on first start
- starts IMAP on `0.0.0.0:1143`
- persists mailbox + DB under a named volume

### Verify server is listening

```bash
docker compose -f docker-compose.imap-gateway.yml logs -f coleo-imap
```

You should see:

```text
[imap] IMAP server listening on 0.0.0.0:1143
```

## Suggested Tailscale funnel/tunnel pattern

- Keep Docker host private.
- Publish only port `1143` into your tailnet.
- Restrict ACLs so only your user/devices can reach the node.

## Operational notes

- Password is stored in Coleo SQLite config as `imap_password`.
- Mailboxes currently exposed: `INBOX`, `SENT`, `DRAFTS`, `ARCHIVE`.
- IMAP behavior is focused on read-first workflows for phase 1.
