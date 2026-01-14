# Open Questions

This document tracks open questions and decisions that need to be made before or during implementation.

## Resolved Questions

### Q1: Monorepo vs Multi-repo

**Question:** Should the web frontend live in the same repo as the backend?

**Decision:** Monorepo with Bun workspaces

**Status:** Resolved

---

### Q2: Arm Naming

**Question:** Should we rename "tentacle" to "arm" throughout the codebase?

**Decision:** Yes, rename to "arm" everywhere. CLI already has `arm` command as alias.

**Status:** Resolved - Implementation pending

---

### Q3: Real-time Protocol

**Question:** WebSocket vs Server-Sent Events (SSE)?

**Decision:** WebSocket for bidirectional communication

**Status:** Resolved

---

### Q7: 3D Garden Technology

**Question:** Which 3D library for the garden visualization?

**Decision:** React Three Fiber

**Status:** Resolved

---

### Q8: Garden Coordinate Configurability

**Question:** Should users be able to customize the X/Y/Z axes?

**Decision:** No - fixed heuristics, simpler and consistent

**Status:** Resolved

---

### Q9: Dark Mode

**Question:** Should the web UI support dark mode?

**Decision:** Yes, dark mode default using Shadcn components

**Status:** Resolved

---

### Q11: Arm Agent Installation

**Question:** How should AI agents be installed in arm containers?

**Decision:** Pre-installed in container images

**Status:** Resolved

---

### Q12: MCP Server Discovery

**Question:** How should arms discover available MCP servers?

**Decision:** Static config in arm profile

**Status:** Resolved

---

## Updated Decisions

### Q4: Proposal Timeouts

**Question:** What should the default timeout be for different proposal types?

**Original proposal:** Wall-clock timeouts (1-15 minutes based on type)

**Feedback:** Should be tick-based (brain poll cycles) rather than wall-clock time, to scale with system speed. User-configurable.

**Updated approach:**
- Use `timeout_ticks` instead of milliseconds
- Default ticks per proposal type:

| Type | Default Ticks | Notes |
|------|---------------|-------|
| deploy (local) | 2 | Fast, low risk |
| deploy (other) | 10 | Needs review time |
| claim | 4 | Quick arbitration |
| refactor | 20 | Needs discussion |
| dependency | 10 | Security review |
| breaking_change | 30 | Major impact |
| creative_override | 2 | Trust the arm |

- All values configurable in `.octopai/config.toml`

**Status:** Resolved - Implemented in migration 005

---

### Q5: Reputation Starting Point

**Question:** What reputation should new arms start with?

**Decision:** 50 (neutral) - arms must earn trust

**Status:** Resolved - Added to schema

---

### Q6: Brain Intervention Thresholds

**Question:** At what point should the brain automatically intervene?

**Decision:**
- **KILL** on first critical pattern (rm -rf, force push, etc.) - configurable
- **PAUSE** after 3 violations in warning window
- **WARN** on first non-critical violation

Configurable via:
- `intervention_kill_on_critical` (default: true)
- `intervention_pause_after_violations` (default: 3)
- `intervention_warn_window_minutes` (default: 60)

**Status:** Resolved - Implemented in migration 005

---

### Q10: Docker Image Strategy

**Question:** How should Docker images be organized?

**Feedback:**
- One main server image for brain + observatory
- Arm images share same environment (NFS mount for source)
- Desktop-requiring arms (browser access) need special handling
- Some arms must run on machines with desktop env, others can be headless

**Decision:**
- `octopai-server` - Brain + Observatory + API
- `octopai-arm-base` - Base image with common tools
- `octopai-arm-opencode` - OpenCode harness
- `octopai-arm-desktop` - For arms needing browser (VNC/noVNC)

Arms share source code via:
- NFS mount (production)
- Bind mount (development)

**Status:** Resolved - needs documentation

---

## New Design Items

### Arm Personality System

Based on feedback, arms now have:

1. **Personality** (~200 tokens)
   - Self-updating context describing how the arm works
   - Updated by the arm as it learns preferences

2. **Convictions** (list of core beliefs)
   - Color the arm's thinking and decisions
   - Influence how they approach problems

3. **Reputation** (0-100)
   - Starts at 50
   - Increases with successful work
   - Decreases with rollbacks/issues

4. **Generation** 
   - Arms can be "reborn" with inherited traits
   - High-reputation arms get recreated when slots available
   - Low-reputation arms die off

**Status:** Implemented in schema

---

## Remaining Open Questions

### Q13: External Tool Integration

**Question:** Which external tools should have first-class MCP integrations?

**Priority candidates:**
- [x] Git (basic operations)
- [ ] Chrome DevTools (via existing MCP server)
- [ ] NX (via their MCP server)
- [ ] Package managers (npm, pnpm)
- [ ] Cloud providers (AWS, GCP, Vercel)
- [ ] Figma (for UI specs)

**Status:** Gather requirements

---

### Q14: Activity Log Retention

**Question:** How long should activity logs be kept?

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

**Status:** Needs more design

---

## How to Provide Feedback

1. Edit this document directly with your thoughts
2. Add comments inline using `> Comment: your feedback here`
3. Create a new section if the question needs discussion
