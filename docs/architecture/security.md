---
title: Security and trust boundaries
description: Authentication, permission decisions, and the trust boundaries of the current Coleo runtime.
banner:
  src: /coleo-architecture-security.png
  alt: An orange octopus watches over an underwater garden.
  eyebrow: Trust Boundaries
  position: center 50%
---

# Security and trust boundaries

Coleo coordinates coding agents running with the access granted to their host
processes and harnesses. Use it with trusted operators and workspaces. Its task
coordination and permission decisions do not provide an operating-system sandbox.

## API authentication

Direct clients normally send the configured shared API key in `X-API-Key`.
The API also accepts the proxy header `X-Coleo-API-Key` and the `api_key` query
parameter. Prefer the header for direct HTTP requests so credentials do not
appear in request URLs.

`GET /api/health` is unauthenticated. When the configured API key starts with
`dev-`, the HTTP middleware bypasses key checking. Reaching the health endpoint
therefore does not demonstrate that an authenticated client connection works.

The shared key is not a per-user or per-arm authorization system. Workbench
profiles organize preferences and attention state; they are not authentication
principals or access-control boundaries.

WebSocket clients authenticate using the socket protocol. The separate web host
proxies browser traffic to the selected API. See [API access](./api) and
[Server and clients](./client-server-separation).

## Permission decisions

The Brain contains a rule-based permission decision engine. It evaluates the
fields supplied in a permission request and returns `approve`, `deny`, or
`escalate`. Rules are priority ordered; the first match wins. A matching action,
tool, command pattern, or file pattern can trigger a rule independently.

Examples with the default automatic decisions enabled:

| Supplied request matching a rule | Decision |
| --- | --- |
| Selected recursive-delete, force-push-to-main/master, destructive SQL, or secret-exposure command patterns | Deny |
| Selected `curl` destination patterns or `chmod 777` patterns | Deny |
| `git reset --hard`, production-deployment patterns, or package-publish commands | Escalate |
| Recognized read, build, or test operations | Approve |
| No matching rule | Escalate |

These are pattern matches on request data, not a shell parser or inspection of
every operation an agent performs. A decision alone is not evidence that a
command was intercepted or prevented.

### Current integration boundary

The health monitor constructs requests from an arm's pending-permission activity.
That path currently supplies action and context, but not the engine's command,
tool, or file fields. Its reply callback sends an ordinary prompt such as
“Yes, proceed.” or “No, do not proceed.”; it is not a universal tool-execution gate.

Coleo does not currently provide repository-wide secret scanning, a pre-commit
secret gate, network egress filtering, or automatic filesystem isolation for
arms. Configure those controls in the execution environment when needed. The
host account's permissions and the harness's own controls remain relevant.

## Credentials and deployment

`coleo-server configure` and `coleo-agent configure` save local operator settings
using a permission-restricted (`0600`) file. This is file access control, not
encrypted credential storage. Keep runtime credentials out of tracked project
files and share them only with the components that need them.

API and NATS credentials serve different transports. Configure NATS access on
the broker and Arm Hosts; an HTTP API key does not authenticate NATS connections.
For remote access, choose the network and TLS arrangement described in the
[Docker guide](../guides/docker). Coleo does not install a firewall policy for
agent processes.

## Implementation references

- [HTTP authentication middleware](https://github.com/sirtimbly/coleo/blob/master/server/src/api/middleware/auth.ts)
- [Permission decision engine](https://github.com/sirtimbly/coleo/blob/master/server/src/brain/permission-engine.ts)
- [Health-monitor request handling](https://github.com/sirtimbly/coleo/blob/master/server/src/brain/health-monitor.ts)
- [Brain callbacks](https://github.com/sirtimbly/coleo/blob/master/server/src/brain/brain.ts)
- [Operator configuration persistence](https://github.com/sirtimbly/coleo/blob/master/server/src/cli/operator-config.ts)
