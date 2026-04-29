# Integration Test Suite

This directory holds runtime-facing tests that cross module boundaries or exercise a real local server/process surface.

## Main areas

- `api-mounted-routes.test.ts`: mounted API route smoke coverage with optional infrastructure probes stubbed
- `brain-runtime-flows.test.ts`: runtime task/arm orchestration paths that touch the real brain logic
- `imap-server.test.ts`: live IMAP protocol behavior for the CLI mail surface
- `mail-gateway.test.ts`: inbound Postmark gateway persistence into Maildir
- `mcp-server-stdio.test.ts`: stdio transport coverage for the spawned MCP server path

## Running the suite

```bash
bun run test:integration:spec
```
