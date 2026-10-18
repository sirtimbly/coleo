# Container web hosting

The bundled images install the browser client and its standalone Bun host at
`/home/coleo/coleo/clients/web/dist/host.js`. `coleo-web` launches that artifact.
The API process serves only API traffic; the web process serves browser files and
proxies `/api`, `/ws` (including WebSockets), and `/uploads` to the internal API.

| Image | Public web/proxy listeners | Internal API |
| --- | --- | --- |
| `Dockerfile` | `COLEO_API_HOST:COLEO_API_PORT` (default `0.0.0.0:8080`) and `COLEO_WEB_HOST:COLEO_WEB_PORT` (default `0.0.0.0:5173`) | `127.0.0.1:8081` |
| `Dockerfile.cloudflare`, `Dockerfile.cloudflare-control` | `0.0.0.0:PORT` (default `3000`) | `127.0.0.1:8081` |

`COLEO_API_INTERNAL_PORT` changes the internal API port and must differ from the
public ports. The historical `COLEO_API_PORT` name on the general-purpose image
remains the public routing port, preserving existing Compose and edge routes.
If both public ports match, only one web host is started, using `COLEO_API_HOST`.
Web hosts always proxy to the local internal API; `COLEO_API_URL` can still select
the connection used by other clients/agents.

Entrypoints supervise the web host alongside the API and background services.
`Dockerfile.cloudflare-agent` remains an arm-only image without a browser client.
Builds use `build:with-web` to produce both server and separately installed web
artifacts; they do not enable static-file hosting in the API.

Local checks (no deployment):

```sh
shellcheck docker/hosting-entrypoint.sh docker/cloudflare-entrypoint.sh docker/cloudflare-control-entrypoint.sh docker/coleo-web
bun test docker/__tests__/web-runtime.test.ts server/src/scripts/__tests__/cloudflare-control-runtime.test.ts
```
