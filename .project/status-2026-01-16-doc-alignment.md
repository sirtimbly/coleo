# Status Report: Documentation & Plan Alignment

**Date:** 2026-01-16

## Summary

Aligned architecture docs, plan, and backlog with the current direction:
- Arms are **general-purpose**; behavior is driven by **task classifications**.
- **Progressive planning** is the core coordination model.
- The near-term mail focus is **Maildir-backed Mail UI & metadata**, not a full IMAP/SMTP gateway.
- Harness documentation reflects the current **opencode-api-only** reality; PTY/GUI harnesses are deferred.

## Changes Made

- **Plan (`.project/plan.md`)**
  - Collapsed duplicate Phase 1 headings into a single **Phase 1: Observatory Foundation** section.
  - Kept core Phase 1 deliverables as present (API, SQLite, WebSocket, React shell, arm list, CLI proxy).

- **Backlog (`.project/tasks/backlog.md`)**
  - Added a **Project Plan Viewer** backlog item under Web UI improvements (file tree of `.project/`, markdown rendering, last-updated timestamps, recently changed highlighting).
  - Reframed the old "Phase 1.5: Email Gateway" section into **"Phase 2.x: Mail UI & Metadata"**, focused on:
    - `/api/mail/*` endpoints for Maildir-backed message listing and retrieval.
    - A Mail view in the Observatory (list + detail + basic reply/compose grounded in Maildir).
  - Marked a full IMAP/SMTP gateway as future work.

- **Harness docs (`docs/architecture/harnesses.md`)**
  - Documented **`opencode-api`** as the only current harness.
  - Marked the PTY-based multi-harness architecture and detailed examples as **future design notes**, not implemented.
  - Updated the planned harness table to:
    - Mark `opencode-api` as implemented.
    - Group other agents as generic "future PTY/GUI" harnesses.

- **Components (`docs/architecture/components.md`)**
  - Replaced **"Arms (Specialized Agents)"** with **"Arms (General-Purpose Agents)"**.
  - Updated `ArmProfile` to focus on **supported task classifications** instead of fixed domains.
  - Removed the default domain table that implied permanent UI/API/testing/devops specialization.

- **Phases (`docs/architecture/phases.md`)**
  - Updated the timeline overview to:
    - Rename Phase 2 to **"Task Classification & Context"**.
    - Mark Phase 1 and Phase 2 as **in progress** instead of planned.

- **Landing page (`docs/index.md`)**
  - Softened the **Email Interface** description to:
    - Emphasize Maildir-backed mail with web/CLI integrations.
    - Note that the IMAP/SMTP gateway is **future work**, not present.

## Notes for Future Work

- Add dedicated architecture sections for:
  - **Status Reporting** – how arm status messages are stored and used in progressive planning.
  - **Documentation Sync** – how documentation update tasks keep feature docs aligned with code.
- Extend plan documents in `.project/plans/` to describe concrete Phase 2.x steps for:
  - Progressive planning implementation.
  - Mail UI & Metadata.
  - Project Plan Viewer.
- Update user-facing guides gradually to remove any remaining references to permanently specialized arms or immediate email gateway support.

This report is informational only and does not change behavior; it documents the alignment work done on 2026-01-16.