# Open Questions

This document tracks open questions and decisions that need to be made before or during implementation.

## Architecture Questions

### Q1: Monorepo vs Multi-repo

**Question:** Should the web frontend live in the same repo as the backend?

**Options:**
- **Monorepo** - Easier to keep in sync, single PR for full features
- **Multi-repo** - Cleaner separation, independent versioning

**Current thinking:** Monorepo with Bun workspaces

**Status:** Open for feedback

---

### Q2: Arm Naming

**Question:** Should we rename "tentacle" to "arm" throughout the codebase?

**Reasoning:** 
- "Arm" is shorter and clearer
- Documentation uses "arm" consistently
- "Tentacle" is still valid but longer

**Impact:** 
- Rename `src/tentacle/` to `src/arm/`
- Update CLI commands
- Update all documentation

**Status:** Pending decision

---

### Q3: Real-time Protocol

**Question:** WebSocket vs Server-Sent Events (SSE)?

**Options:**
- **WebSocket** - Bidirectional, more complex
- **SSE** - Server-to-client only, simpler, HTTP-based

**Current thinking:** WebSocket, since we need client-to-server messages (subscribe/unsubscribe)

**Status:** Decided - WebSocket

---

## Governance Questions

### Q4: Proposal Timeouts

**Question:** What should the default timeout be for different proposal types?

**Current proposal:**

| Type | Timeout |
|------|---------|
| deploy (local) | 1 minute |
| deploy (other) | 5 minutes |
| claim | 2 minutes |
| refactor | 10 minutes |
| dependency | 5 minutes |
| breaking_change | 15 minutes |
| creative_override | 1 minute |

**Status:** Open for feedback

---

### Q5: Reputation Starting Point

**Question:** What reputation should new arms start with?

**Options:**
- **50** (neutral) - Must earn trust
- **75** (trusted) - Assume good faith initially
- **Configurable per domain** - UI arms start higher in UI work

**Current thinking:** 50 (neutral) with quick reputation gains for early success

**Status:** Open for feedback

---

### Q6: Brain Intervention Thresholds

**Question:** At what point should the brain automatically intervene?

**Current proposal:**
- **WARN** - First violation
- **PAUSE** - 3 violations in 1 hour, or 2 of same type
- **KILL** - Any critical pattern (rm -rf, etc.)

**Status:** Open for feedback

---

## UI/UX Questions

### Q7: 3D Garden Technology

**Question:** Which 3D library for the garden visualization?

**Options:**
- **React Three Fiber** - React bindings for Three.js, most popular
- **Three.js direct** - More control, less abstraction
- **Babylon.js** - Alternative engine, good performance

**Current thinking:** React Three Fiber for React integration

**Status:** Decided - React Three Fiber

---

### Q8: Garden Coordinate Configurability

**Question:** Should users be able to customize the X/Y/Z axes?

**Options:**
- **Fixed heuristics** - Simpler, consistent
- **Fully configurable** - More flexible, more complex
- **Presets + custom** - Best of both?

**Current thinking:** Sensible defaults with the ability to override per-project

**Status:** Open for feedback

---

### Q9: Dark Mode

**Question:** Should the web UI support dark mode?

**Options:**
- **Dark only** - Many developers prefer dark
- **Light only** - Simpler to build
- **System preference** - Best UX, more work

**Current thinking:** Dark mode default, system preference toggle later

**Status:** Open for feedback

---

## Deployment Questions

### Q10: Docker Image Strategy

**Question:** How should Docker images be organized?

**Options:**
- **Single image** - Brain + Observatory + everything
- **Separate images** - Brain, Observatory, Arm (per agent type)
- **Hybrid** - One core image, agent images extend it

**Current thinking:** Hybrid - octopai-core image, octopai-arm-opencode, etc.

**Status:** Open for feedback

---

### Q11: Arm Agent Installation

**Question:** How should AI agents (OpenCode, Claude Code) be installed in arm containers?

**Options:**
- **Pre-installed** - Part of the arm image
- **Volume mount** - Mount from host
- **Runtime install** - Download on first run

**Current thinking:** Pre-installed in specific arm images (simpler, more reliable)

**Status:** Open for feedback

---

## Integration Questions

### Q12: MCP Server Discovery

**Question:** How should arms discover available MCP servers?

**Options:**
- **Static config** - Define in arm profile
- **Dynamic discovery** - Brain advertises available servers
- **Both** - Static defaults, dynamic overrides

**Current thinking:** Static config in arm profile, expandable later

**Status:** Decided - Static config

---

### Q13: External Tool Integration

**Question:** Which external tools should have first-class MCP integrations?

**Priority candidates:**
- [x] Git (basic operations)
- [ ] Chrome DevTools (via existing MCP server)
- [ ] NX (via their MCP server)
- [ ] Package managers (npm, pnpm)
- [ ] Cloud providers (AWS, GCP, Vercel)
- [ ] Figma (for UI specs)
- [ ] Linear/Jira (for issue tracking)

**Status:** Gather requirements

---

## Data Questions

### Q14: Activity Log Retention

**Question:** How long should activity logs be kept?

**Options:**
- **7 days** - Short, low storage
- **30 days** - Medium, reasonable history
- **90 days** - Long, full audit trail
- **Configurable** - Let user decide

**Current thinking:** 30 days default, configurable

**Status:** Open for feedback

---

### Q15: State Recovery

**Question:** What should happen when the brain restarts?

**Current proposal:**
1. Load arm states from database
2. Check if arm processes are still running (by PID)
3. Mark dead arms as "dead"
4. Resume pending proposals
5. Continue normal operation

**Concerns:**
- What about in-progress deployments?
- Should arms auto-reconnect?

**Status:** Needs more design

---

## How to Provide Feedback

1. Edit this document directly with your thoughts
2. Add comments inline using `> Comment: your feedback here`
3. Create a new section if the question needs discussion

### Feedback Format

```markdown
### Q#: Question Title

> **[Your Name] Feedback:**
> Your thoughts here...

**Resolution:** What was decided
**Status:** Resolved / Open / Needs Discussion
```
