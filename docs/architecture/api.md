---
title: API access
description: How clients authenticate and communicate with the Coleo API.
---

# API access

The Coleo server provides HTTP APIs and a WebSocket connection. User clients
submit operations through the API; the API owns application persistence and
communication with Arm Hosts. Browser assets are served by the separate web host.

## HTTP authentication

For direct access, send the shared API key in a header:

```sh
curl --fail --show-error \
  -H "X-API-Key: $COLEO_API_KEY" \
  "$COLEO_API_URL/api/status"
```

Set `COLEO_API_URL` to the server origin, such as `http://127.0.0.1:8080`, without
adding `/api`. Missing or incorrect credentials return HTTP 401 when shared-key
authentication is enabled.

`GET /api/health` does not require authentication. Development keys beginning
with `dev-` bypass HTTP key checks. The proxy header `X-Coleo-API-Key` and the
`api_key` query parameter are also accepted by the middleware; direct clients
should use the header shown above.

The key grants access to the shared API. There is no per-arm scoped-key system
or Coleo-installed network rule that limits arms to MCP access. MCP is the
coordination interface, not a network sandbox. See [Security and trust
boundaries](./security).

## Check a connection

The workspace client checks the selected server through an authenticated route:

```sh
coleo-client connect http://127.0.0.1:8080 --name local --prompt-key
coleo-client doctor --json
```

The diagnostic distinguishes a reachable endpoint from a failed request. A
successful response does not by itself identify the server's authentication
mode; development bypass or an upstream proxy may apply.

## WebSocket updates

Live clients connect to `/ws` and authenticate using the socket protocol before
receiving protected updates. Update messages tell clients when to refresh their
HTTP snapshots. Treat reconnect and refresh as separate steps: reconnecting a
socket does not make previously loaded data current.

## API families

| Area | Examples | Further reading |
| --- | --- | --- |
| Runtime inventory | `/api/status`, `/api/arms`, `/api/agents` | [Server and clients](./client-server-separation) |
| Tasks | `/api/tasks` | [Task workflow](../guides/task-workflow) |
| Coordination | `/api/brain/*` | [Brain/API boundary](./brain-api-boundary) |
| Workbench | `/api/workbench/*` | [Workbench across clients](./workbench-clients) |
| Search | `/api/search`, `/api/status-history/search` | [Search API](../guides/search-api) |
| Messaging | `/api/mail/*` | [Communicate with the Brain](../guides/communicate-with-brain) |

This page describes access and transport, not a complete endpoint schema. Route
implementations and their tests live in
[`server/src/api/routes/`](https://github.com/sirtimbly/coleo/tree/master/server/src/api/routes).
