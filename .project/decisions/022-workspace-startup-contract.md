# ADR-022: Workspace-Startup and Repository-Preparation Contract

## Status

Accepted

## Date

2026-09-22

## Context

Workspace startup spans overlapping layers — onboarding API and CLI,
`docker/prepare-repository.sh`, hosting/Cloudflare entrypoints, web
startup/connection notices, arm-host discovery, and DB migration
defaults — with no stated ownership. Verified 2026-09-22 by reading
`docker/prepare-repository.sh`, `docker/hosting-entrypoint.sh`,
`src/api/routes/onboarding.ts`, `src/project-setup/service.ts`,
`src/web/src/components/{ProjectOnboarding,WorkspaceStartup,WorkspaceConnectionNotice}.tsx`,
`src/web/src/hooks/use-arm-hosts.ts`, and the existing tests
(`prepare-repository.test.ts`: 12 cases;
`onboarding.test.ts`: 7 cases; `project-setup` service tests). This
record assigns each layer its responsibility and failure behavior.

## Decision

### 1. Layer ownership

| Layer | Owns | Must never |
|---|---|---|
| `prepare-repository.sh` | Safe checkout: clone into empty dirs, keep matching checkouts (switching SSH remotes to authenticated HTTPS), block-and-backup replacement only with API approval | Reset, pull, clean, or delete a user checkout; mistake a parent repo or worktree for its target |
| Onboarding API (`/api/onboarding`) + `coleo init` | Project state: detect non-Git dirs, report repo metadata, generate SSH keys, validate URLs, clean partial clones, route to a remote Arm Host or fail closed | Clone in the control container when `COLEO_REMOTE_ARMS_ONLY=1` and no host is available |
| Hosting/Cloudflare entrypoints | Service order: repo setup → `init` state if absent → API → web → brain → agent; env-flag selection (`COLEO_INIT_ON_START`, `COLEO_START_BRAIN/AGENT/SSH`, `COLEO_GIT_PULL_ON_START`) | Start dependents before their prerequisites; pull a dirty checkout (ff-only, opt-in) |
| Web notices (`WorkspaceStartup`, `WorkspaceConnectionNotice`, `ProjectOnboarding`) | Reflect API-reported startup/connection state; guide onboarding | Claim ready state the API has not reported |
| Arm-host discovery (`use-arm-hosts`, spawn flows) | Locate/select the host that executes workspace operations | Execute workspace mutations without a discovered host |
| Migration catalog (`src/db`) | Forward-only schema with checksums and epoch gating; incompatible startup demands a compatible backup restore (ADR-021) | Auto-downgrade or edit applied-migration records |

### 2. Startup order and failure propagation

`COLEO_WORKDIR` (absolute, non-symlink, non-root) → repository present
and matching → `.coleo` state initialized → migrations compatible →
API serves → web/brain/agent attach. Each stage fails closed with an
actionable message naming the missing input or unavailable service;
later stages never start on an unverified earlier stage.
`prepare-repository.sh` exits non-zero for missing `COLEO_WORKDIR`,
relative/unsafe paths, blocked conflicts, unapproved or failed
replacement, and failed clones — leaving originals untouched and no
staging directories behind (all covered by tests).

### 3. Failure-path test requirements

New startup behavior ships with failure-path tests, not happy paths
alone: absent/invalid configuration, preparation-script refusal,
unavailable control/host services, missing arm-host discovery,
incompatible migrations, and failed clone/replacement. The
12-case `prepare-repository` suite and 7-case onboarding suite are the
pattern to follow.

## Consequences

- Entrypoint or onboarding changes must update this record when layer
  ownership or startup order changes.
- UI startup surfaces must be backed by API state; static or optimistic
  readiness is a bug.
- Migration-default changes follow ADR-020 (serialized authorship) and
  ADR-021 (backup-first, epoch discipline).

## Related Records

- ADR-019 (commands), ADR-020 (isolation), ADR-021 (rollback safety)
- `docker/prepare-repository.sh`, `docker/hosting-entrypoint.sh`,
  `src/api/routes/onboarding.ts`, `src/project-setup/service.ts`
