# ADR-008: Docker Image Strategy

**Status**: Accepted  
**Date**: 2025-01-13  
**Deciders**: Human

## Context

Need to define how Docker images are organized for:
- Brain + Observatory (the server)
- Arms (the agents)
- Development vs production

## Decision

### Image Hierarchy

```
octopai-base
├── octopai-server      (brain + observatory + API)
└── octopai-arm-base
    ├── octopai-arm-opencode
    ├── octopai-arm-claude
    └── octopai-arm-desktop  (with VNC)
```

### octopai-server

Contains:
- Brain polling loop
- Observatory API (Hono)
- SQLite database
- MCP server

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install --production
EXPOSE 8080
CMD ["bun", "run", "src/cli/index.ts", "server", "start"]
```

### octopai-arm-base

Common tools for all arms:
- Git
- Node.js/Bun
- Common build tools

```dockerfile
FROM oven/bun:1
RUN apt-get update && apt-get install -y \
    git curl jq ripgrep
```

### octopai-arm-opencode

OpenCode agent installed:

```dockerfile
FROM octopai-arm-base
RUN curl -fsSL https://opencode.ai/install.sh | bash
# Or npm install -g @anthropic/opencode
```

### octopai-arm-desktop

For arms needing browser/display:

```dockerfile
FROM octopai-arm-opencode
RUN apt-get install -y \
    xvfb x11vnc fluxbox \
    chromium firefox
EXPOSE 5900 6080
```

## Source Code Access

Arms need access to the project source. Options:

### Development: Bind Mount

```yaml
services:
  arm-backend:
    image: octopai-arm-opencode
    volumes:
      - ./:/workspace
```

### Production: NFS/Shared Volume

```yaml
volumes:
  workspace:
    driver: local
    driver_opts:
      type: nfs
      o: addr=nas.local,rw
      device: ":/exports/octopai-workspace"
```

All arms mount the same workspace, enabling:
- Shared git state
- Immediate visibility of changes
- Conflict detection by brain

## Docker Compose (Development)

```yaml
version: '3.8'

services:
  server:
    build: 
      context: .
      dockerfile: Dockerfile.server
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      - OCTOPAI_DB_PATH=/data/octopai.db

  arm-backend:
    build:
      context: .
      dockerfile: Dockerfile.arm-opencode
    volumes:
      - ./:/workspace
    depends_on:
      - server
    environment:
      - OCTOPAI_SERVER=http://server:8080
```

## Consequences

- Clear separation of concerns
- Arms are stateless (can be killed/recreated)
- Server holds all persistent state
- Easy to add new agent types
- Development uses bind mounts, production uses NFS
