# ADR-007: Desktop vs Headless Arm Distribution

**Status**: Accepted  
**Date**: 2025-01-13  
**Deciders**: Human

## Context

Some arms need access to a graphical environment (browser, visual testing), while others can run entirely headless. Need a strategy for distributing arms across available compute.

## Decision

Arms are classified by their display requirements:

1. **Headless arms** - Run in containers, no display needed
2. **Desktop arms** - Need display, run on machines with GUI

## Headless Arms

Can run anywhere:
- Docker containers (production)
- Kubernetes pods
- Remote servers via SSH
- CI/CD runners

Examples:
- Backend development
- Database work
- API testing
- Documentation
- Code review

## Desktop Arms

Need graphical environment for:
- Browser automation (Playwright, Puppeteer)
- Visual testing/screenshots
- Figma integration
- UI development with hot reload

Options for running desktop arms:

### Option A: Local Machine (Recommended for dev)

Run on developer's laptop/desktop:
```bash
octopai arm spawn --name frontend --agent opencode --domain frontend
```

Arm opens in local terminal, has access to local browser.

### Option B: VNC Container

For remote/CI environments:
```dockerfile
FROM octopai-arm-base
RUN apt-get install -y xvfb x11vnc fluxbox
# ... VNC setup
```

Access via noVNC in browser or VNC client.

### Option C: Dedicated Desktop Server

A Mac Mini or similar always-on machine:
- Runs desktop arms
- Accessible via screen sharing
- Brain routes browser-requiring tasks here

## Configuration

In `.octopai/arms/<name>.toml`:

```toml
[arm.tools]
requires_browser = true
requires_display = true
preferred_host = "desktop-server"  # optional
```

## Task Routing

Brain considers display requirements when assigning tasks:

```typescript
function findAvailableArm(task: Task): Arm | null {
  const requiresDisplay = task.tags.includes('ui') || 
                          task.tags.includes('visual');
  
  return arms.find(arm => 
    arm.status === 'idle' &&
    arm.domain === task.domain &&
    (!requiresDisplay || arm.hasDisplay)
  );
}
```

## Implementation Phases

1. **Phase 1**: All arms on local machine (current)
2. **Phase 2**: Headless containers for non-UI arms
3. **Phase 3**: VNC containers for remote desktop arms
4. **Phase 4**: Smart routing based on arm capabilities

## Consequences

- UI work naturally routes to capable machines
- Headless work can scale in containers
- Need to track arm capabilities in database
- May need multiple arm pools (headless pool, desktop pool)
