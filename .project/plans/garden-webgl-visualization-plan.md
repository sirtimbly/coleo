# Garden WebGL Visualization Plan

## Purpose

Build the `Garden` view as a live underwater observatory of the shared workspace rather than a static file browser or backlog board.

This plan follows the current product direction:

- `plan.md`: the UI should emphasize live activity, next work, and transparency rather than CRUD-only backlog management.
- `philosophy.md`: the garden is the shared workspace tended by general-purpose arms under brain coordination.
- `communicate-with-brain.md`: the brain is the routing and orchestration center for human and arm communication.
- `brain-api-boundary.md`: live orchestration data must reach the web through API-owned contracts.
- `components.md`: arms, the brain, interventions, task assignment, and health monitoring are first-class system behaviors and should be visible.

## Experience Direction

The garden should feel submerged, luminous, and operational:

- Dark background, like deep water.
- Bright bioluminescent colors reserved for live signals, active agents, conflicts, warnings, and motion.
- Calm baseline motion with stronger animation only when something meaningful changes.
- The scene should reward exploration, but it must remain readable as an observability surface.

The garden is not a generic 3D code map. It is a living operational map of Coleo.

## Constraints From Existing Docs

- Use React Three Fiber for rendering. This is already the recorded decision in `docs/architecture/questions.md`.
- Keep axis heuristics fixed. Users can toggle layers and display settings, but they should not redefine the semantic axes.
- Data should come from API routes or API-owned aggregate endpoints, not direct browser access to SQLite or JetStream.
- The view should emphasize current work, active coordination, and conflict/risk areas.

## Current State In Repo

### Already present

- `src/web/src/pages/GardenPage.tsx` is a placeholder only.
- `src/api/routes/garden.ts` already exposes:
  - `GET /api/garden`
  - `GET /api/garden/tree`
  - `GET /api/garden/claims`
  - `POST /api/garden/claims`
  - `DELETE /api/garden/claims/:id`
  - `GET /api/garden/conflicts`
  - `GET /api/garden/activity`
- The current garden API is file-claim centric and not rich enough for a full observability scene.
- Web package dependencies do not yet include `three`, `@react-three/fiber`, or `@react-three/drei`.

### Gap to fix

- `src/web/src/lib/api.ts` includes `getUserPreferences` and `updateUserPreference`, but there is no matching API route or schema for user preferences on the server today.
- Current `/api/garden` coordinates are deterministic path hashes. They are adequate for a placeholder but not for a meaningful spatial model.

## Recommended Scene Model

Use a hybrid scene with three layers:

1. `Core layer`
   The brain and active arms.

2. `Work layer`
   Tasks, bugs, discoveries, claims, and file/worktree anchors.

3. `Ambient layer`
   Messages, interventions, status/health signals, and historical traces.

This keeps the experience aligned with Coleo's philosophy: the garden is a shared workspace with coordinated actors, not just a file topology.

## Spatial Heuristics

Keep the existing idea of semantic coordinates, but update the meanings:

- `X axis`: workspace district
  - group by worktree first when present
  - otherwise group by top-level path area or system area (`src/api`, `src/brain`, `src/web`, `docs`, `.project`, mail, infra)
- `Y axis`: operational urgency / activation
  - low Y: dormant or historical entities
  - mid Y: active work items
  - high Y: urgent states, conflicts, blocked items, critical bugs, escalations
- `Z axis`: time freshness
  - back: older context
  - front: recent events, active claims, live messaging

These should be fixed heuristics, not user-editable axes.

## Visual Language Reduction

The first draft had too many bespoke object families. That will make the garden noisy quickly.

Reduce the scene to a small reusable vocabulary:

- `Hero forms`
  - only the brain and arms get distinct silhouettes

- `Work forms`
  - tasks and active bugs get one stronger shared family of shapes with state-based variation

- `Bubble forms`
  - lower-priority or lower-frequency entities become colored bubbles with size, glow, and jiggle differences instead of custom geometry

- `Link forms`
  - claims, dependencies, consensus, and brain-arm connections are mostly translucent lines, ribbons, or currents

This keeps the scene readable while still allowing the system to encode many kinds of data.

## Object Vocabulary

### Primary scene objects

- `Brain nucleus`
  - source: `brain_state`
  - one central object
  - state changes affect pulse rate and color
  - visual form: a softly pulsing nucleus with a brighter outer membrane
  - should feel stable, central, and heavier than every other object in the scene

- `Arm swimmers`
  - source: `arms`, `arm_state_machine`, runtime summary, arm activity analysis
  - moving objects that travel between current work anchors
  - color is per-arm identity; motion and aura are driven by state
  - visual form:
    - a bright "tip" or lure is the primary visible body
    - the rest of the arm is implied by a mostly translucent tether back toward the brain
    - the tether should be visible enough to communicate coordination, but faint enough not to web over the scene
  - design rule:
    - users should notice the active tip first
    - they should only notice the brain connection when they look for it

- `Arm-to-brain tentacles`
  - source: derived from arm identity and brain membership, optionally modulated by messages or assignment events
  - every arm is connected back to the brain
  - visual form:
    - a thin translucent spline or ribbon from brain to arm tip
    - strongest opacity near the arm tip and near the brain surface
    - weakest opacity along the mid-span
    - slight animated flow toward the arm during assignment/work, back toward the brain during reporting/completion
  - clutter controls:
    - base opacity must stay low
    - thicken/highlight only for hovered arm, selected arm, or arms with critical states
    - collapse to very faint strands when zoomed out
  - interpretation:
    - this is not a "hard pipe"
    - it is a living, semi-visible coordination tether
    - the effect should suggest a tentacle without rendering a thick octopus limb across the whole canvas

- `Task fronds`
  - source: `tasks`
  - main workload objects
  - clustered by workspace district and linked to assigned arms and related file claims
  - visual form:
    - one shared organic shape family
    - state changes modify bloom amount, brightness, and surface agitation rather than switching to totally new geometry

- `Bug urchins`
  - source: `bugs`
  - sharp, warning-colored objects near affected task or workspace district
  - keep as a distinct form because bugs are operationally important and benefit from stronger visual contrast

- `Discovery pearls`
  - source: `discoveries`
  - smaller bright findings attached to a task or file anchor
  - simplify to bubble form in v1

- `Claim strands`
  - source: `claims`
  - glowing lines or wraps between arms and file anchors
  - keep visually minimal; they are support structure, not hero geometry

- `Workspace anchors`
  - source: computed from workdir, claims, touched paths, and optional worktree metadata
  - districts or reef clusters that other objects attach to

### Secondary overlay objects

- `Proposal bubbles`
  - source: `proposals`
  - colored bubbles orbiting closer to the brain
  - jiggle in place; color and glow carry status

- `Discovery bubbles`
  - source: `discoveries`
  - attached near task clusters or workspace anchors
  - small bubble form with severity and phase tinting

- `Verification bubbles`
  - source: `task_verifications`
  - small bubbles near tasks in verification flow

- `Status bubbles`
  - source: `status_reports`
  - small transient bubbles near emitting task or arm

- `Context pressure halos`
  - source: `context_compressions`, arm budget fields
  - rings or haze around arms near budget limits

- `Intervention shockwaves`
  - source: `interventions`
  - warning pulses around arms that were warned, paused, or killed

- `Message currents`
  - source: `messages`, mail inbox/outbox summaries, task comments
  - animated particles traveling between human/brain/arms/tasks

- `Health bubbles`
  - source: `infrastructure_health`
  - small fixed colored bubbles near the scene edge

### Optional/admin objects

- `Shared memory bubbles`
  - source: `notes`, `tools`
  - disabled by default; useful for system introspection mode

- `Doc update bubbles`
  - source: `doc_updates`
  - periodic maintenance signals near docs district

- `Media bubbles`
  - source: `uploaded_media`
  - attached to task comments or discussions when relevant

## Bubble Simplification Rules

Anything that is not central to "who is working, on what, and how that work relates to the brain" should default to a bubble treatment in v1.

Bubble rules:

- spherical or slightly organic round shape
- subtle idle jiggle in place
- meaning carried by:
  - color
  - size
  - glow
  - orbit radius
  - attachment point
- no bespoke geometry unless the entity is frequently referenced or operationally urgent

Default bubble candidates:

- proposals
- discoveries
- status reports
- task verifications
- infrastructure health
- notes/tools
- doc updates
- uploaded media markers

## Database Table Evaluation

This is the recommended visual treatment for the current schema.

### Represent directly in 3D

- `arms`
- `arm_state_machine`
- `tasks`
- `bugs`
- `discoveries`
- `claims`
- `proposals`
- `task_arm_consensus`
- `status_reports`
- `task_verifications`
- `context_compressions`
- `interventions`
- `brain_state`
- `messages`
- `infrastructure_health`

### Use as placement/attachment metadata

- `file_subscriptions`
- `file_changes`
- `project_phases`
- `plan_files`
- `doc_updates`
- `mail_thread_map`
- `task_comments`
- `uploaded_media`

### Use only for scene support or admin/debug

- `config`
- `activity`
- `tools`
- `notes`
- `arm_state_events`
- `task_comment_reads`
- `_migrations`

### Do not model as independent nodes in v1

- `task_dependencies`
  - render as relationship lines only

- `messages`
  - do not create a permanent node per message; use moving currents and counts

- `activity`
  - treat as an event source, not a durable object

## Arm State Mapping

The garden should reconcile four existing state surfaces:

### Lifecycle state machine

From `src/brain/arm-state-machine.ts` and `arm_state_machine`:

- `spawning`
- `starting`
- `idle`
- `task_assigned`
- `working`
- `completing`
- `disconnected`
- `stopped`
- `error`

These should drive the arm's main animation and placement.

## Arm Representation Details

Arms are the most delicate part of the scene because they carry the octopus metaphor and can create clutter if overdrawn.

### Core arm design

Each arm should have two visual parts:

- `Visible tip`
  - the bright, readable part the user tracks
  - this is what moves between tasks, bugs, and workspace anchors
  - shape can be a teardrop, lure, or rounded triangular point rather than a full creature body

- `Translucent tentacle`
  - the implied connection back to the brain
  - rendered as a thin, low-opacity spline or ribbon
  - should not dominate the frame

### Brain connection behavior

Every arm remains connected to the brain at all times, but the visual emphasis changes:

- `idle`
  - arm tip hovers near the arm reef
  - tether is faint and relaxed

- `task_assigned`
  - a visible pulse travels from brain to arm tip
  - tether brightens briefly

- `working`
  - arm tip moves toward its task cluster
  - tether remains visible but subdued
  - occasional tiny pulses can travel in both directions

- `completing`
  - reverse pulse toward the brain
  - tether brightness rises slightly

- `disconnected`
  - tether thins, flickers, or partially breaks

- `error`
  - tether destabilizes with red/orange noise

- `stopped`
  - tether fades almost completely
  - arm tip dims and settles

### Selection behavior

When an arm is hovered or selected:

- its tip enlarges slightly
- its tether becomes more legible
- linked tasks, bugs, discoveries, and claims should brighten
- unrelated tethers should fade back further

### Distance management

To avoid visual mess:

- far zoom:
  - only show arm tips and the faintest suggestion of tethering
- medium zoom:
  - show full tether silhouette at low opacity
- near zoom or selected state:
  - show the full tentacle curve and subtle flowing motion

### Link layering

The brain-arm tether is the primary long-span link in the scene.

Other links should remain subordinate:

- claim links thinner than brain-arm tentacles
- consensus/dependency links thinner than claim links
- message currents should read as particles, not solid wires

This ensures the octopus structure remains readable: brain first, arms second, everything else after that.

### Legacy/status row state

From `arms.status`:

- `idle`
- `busy`
- `paused`
- `error`
- `stopped`
- `starting`
- `running`

Keep this for compatibility, but prefer state machine state when available.

### Runtime health state

From arm runtime summaries:

- `starting`
- `active`
- `quiet`
- `hung`
- `recoverable`
- `stopped`
- `unknown`

Use this to modify arm posture and urgency effects.

### Activity analysis state

From event-window analysis:

- `productive`
- `idle`
- `waiting_permission`
- `looping`
- `silent`
- `error`
- `starting`

Use this as a behavior overlay:

- `waiting_permission`: amber beacon and paused drift
- `looping`: tight circular motion
- `silent`: dimmed object
- `productive`: strong forward trail

## Task, Bug, Discovery, and Proposal State Mapping

### Tasks

Current task states in the API layer:

- `pending`
- `claimed`
- `in_progress`
- `completing`
- `completed`
- `failed`
- `blocked`
- `cancelled`

Recommended visuals:

- `pending`: dormant seed
- `claimed`: tethered, beginning to glow
- `in_progress`: open bioluminescent bloom
- `completing`: tightening ring + verification beacon
- `completed`: faded coral with archival dimming
- `failed`: fractured red shell
- `blocked`: amber knot with blocker link
- `cancelled`: greyed remnant

### Bugs

- `open`
- `investigating`
- `fixing`
- `verifying`
- `resolved`
- `closed`

Bugs should occupy negative space around affected tasks and districts, becoming visually sharper as severity increases.

### Discoveries

- `open`
- `acknowledged`
- `resolved`
- `dismissed`

Discoveries should be smaller attached findings, with phase-based tinting:

- `exploration`
- `implementation`
- `verification`

### Proposals

- `open`
- `accepted`
- `rejected`
- `withdrawn`
- `expired`

Proposals belong closer to the brain and governance layer than to raw file topology.

## Scene Structure

### Recommended districts

- `Brain Grove`
  - brain nucleus
  - proposal bubbles
  - global message currents

- `Arm Reef`
  - active and inactive arms
  - context, health, and intervention overlays

- `Work Beds`
  - task, bug, discovery, and verification clusters by workspace district

- `Claim Kelp`
  - file/worktree anchors and ownership strands

- `Boundary Shelf`
  - infrastructure health, mail ingress, background system indicators

This produces a meaningful scene even when the filesystem itself is sparse.

## Interaction Design

### Navigation

Required controls:

- mouse drag orbit
- mouse right-drag or modifier drag pan
- mouse wheel dolly / zoom
- `WASD` and arrow keys for planar movement

Implementation recommendation:

- use `CameraControls` from `@react-three/drei` for mouse behavior
- add a custom keyboard navigator that translates both camera position and target across the X/Z plane
- support focus mode when an object is selected

### Selection and inspection

- hover: lightweight tooltip
- click: select object and open right-side inspector
- double click: focus camera on object cluster
- escape: clear selection

### Keyboard behavior

- `W` / `ArrowUp`: move forward
- `S` / `ArrowDown`: move backward
- `A` / `ArrowLeft`: move left
- `D` / `ArrowRight`: move right
- `[` and `]` optional for slower/faster travel if desired later

## Garden Configuration Panel

Add a docked panel in the garden view. This is not for semantic axis changes; it is for layer visibility and presentation settings.

### v1 toggles

- show arms
- show tasks
- show bugs
- show discoveries
- show proposals
- show claims
- show message currents
- show health overlays
- show archived/completed items
- show labels
- show link lines
- follow selected arm

### v1 display controls

- brightness
- bloom intensity
- motion intensity
- node density / LOD bias
- auto-rotate on/off
- time window for recent activity

### Persistence

Preferred:

- persist in API-backed user preferences

Current repo reality:

- the web client has preference methods
- the server route/schema is missing

Plan:

- implement server-backed user preference storage or
- fall back to localStorage first, then migrate to API preferences later

## API Plan

The current `/api/garden` endpoints are a useful seed but too narrow. Expand them into an aggregate scene contract.

### Recommended endpoints

- `GET /api/garden/scene`
  - full scene snapshot
  - arms, tasks, bugs, discoveries, proposals, claims, workspace anchors, overlays, stats

- `GET /api/garden/scene/delta?since=...`
  - optional later optimization for polling or resumable updates

- `GET /api/garden/object/:kind/:id`
  - focused inspector payload with linked entities

- `GET /api/garden/config`
  - feature flags, thresholds, palette metadata if needed

### Keep and adapt existing endpoints

- keep `GET /api/garden/claims`
- keep `GET /api/garden/conflicts`
- keep `GET /api/garden/activity`
- either deprecate current `GET /api/garden` or convert it to the new scene payload

### Scene payload shape

Recommended top-level sections:

- `brain`
- `arms`
- `workspaceAnchors`
- `tasks`
- `bugs`
- `discoveries`
- `proposals`
- `claims`
- `links`
- `events`
- `stats`

This should be a presentation-oriented aggregate contract, not a raw table dump.

## Web Architecture Plan

### New frontend modules

- `src/web/src/components/garden/GardenScene.tsx`
- `src/web/src/components/garden/GardenCanvas.tsx`
- `src/web/src/components/garden/GardenControlsPanel.tsx`
- `src/web/src/components/garden/GardenInspector.tsx`
- `src/web/src/components/garden/GardenLegend.tsx`
- `src/web/src/components/garden/layers/*`
- `src/web/src/components/garden/rendering/*`
- `src/web/src/hooks/useGardenScene.ts`
- `src/web/src/lib/garden/*`

### Suggested dependencies

- `three`
- `@react-three/fiber`
- `@react-three/drei`

Optional later:

- post-processing package for bloom

Do not introduce an external debugging control panel like `leva` for the user-facing product panel.

## Rendering Plan

### v1 rendering choices

- Instanced meshes for repeated small objects such as discoveries or claim anchors.
- Line segments or tubes for claim and dependency links.
- Minimal but meaningful animation:
  - arm drift
  - arm-to-brain pulse flow
  - active pulse
  - message currents
  - conflict shimmer

### Performance guardrails

- Start with aggregated workspace anchors, not one permanent mesh per file in the repo.
- Only render file-level nodes for claimed/touched/selected paths.
- Use LOD and cull labels aggressively.
- Keep detailed inspector data in DOM, not inside the canvas.

## Data Prioritization For v1

To keep the first useful version operationally relevant:

### Must-have

- brain
- arms
- tasks
- bugs
- discoveries
- claims
- conflicts
- recent activity

### Good v1 additions

- proposal bubbles
- task consensus links
- status reports
- context pressure

### Later

- worktree islands
- notes/tools memory layer
- mail thread animation
- verification history trails

## Phased Delivery

### Phase A: Scene foundation

- install 3D dependencies
- replace placeholder page with canvas shell
- add camera controls, keyboard navigation, and inspector shell
- add local config panel state

### Phase B: Aggregate scene API

- expand garden API into scene snapshot contract
- include arms, tasks, bugs, discoveries, proposals, claims, conflicts
- add computed workspace anchors and link graph

### Phase C: Core rendering

- render brain, arms, tasks, bugs, discoveries, claims
- add color, labels, selection, and focus
- add live refresh from polling and/or WebSocket event integration

### Phase D: Operational overlays

- status reports
- interventions
- context pressure
- message currents
- infrastructure health shelf

### Phase E: Persistence and polish

- persist panel settings
- add scene legend and onboarding copy
- add reduced-motion handling
- add worktree islands if/when worktree model is active

## Recommended Visual Rules

- Dark water background should carry most of the scene.
- Use bright cyan, lime, amber, coral, and magenta accents for live meaning.
- Reserve red for errors, interventions, and critical bugs.
- Completed or inactive objects should dim instead of disappearing immediately.
- Avoid making every table a permanent bright object; many tables should appear only as bubbles, links, overlays, or inspector details.
- The brain-arm relationship should be visible from most views, but only as a subtle structure until the user focuses on a specific arm.

## Risks

- Rendering full file topology will become noise quickly; the scene should stay workload-centric.
- Multiple arm state surfaces can disagree. The scene model should define precedence:
  - `arm_state_machine`
  - runtime summary
  - `arms.status`
  - activity analysis overlay
- The missing server-backed user preferences route will block real persistence unless added.
- Task state mismatch exists today: the API route supports `completing`, while the web `Task` type currently omits it.

## First Implementation Checklist

- Add 3D dependencies to `src/web/package.json`
- Create `useGardenScene` hook and scene types
- Expand garden API from claim-only nodes to aggregate scene nodes
- Replace placeholder `GardenPage` with canvas + panel + inspector layout
- Implement camera controls and keyboard navigation
- Render core layer: brain, arms, tasks, bugs, discoveries, claims
- Add live refresh and selection
- Add persistence for panel settings

## Summary

The right first version of the garden is not "every file in 3D". It is a live underwater operations map of Coleo:

- the brain at the center
- arms represented by bright tips with faint tentacles back to the brain
- tasks and bugs as the main non-brain object families
- discoveries, proposals, and other secondary entities simplified into colored bubbles
- claims and recent activity grounding the scene in the actual workspace
- a configuration panel that controls visibility and display without breaking fixed semantic axes
