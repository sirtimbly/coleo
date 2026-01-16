# Status – 2026-01-16 – Domain Deprecation & Classification Alignment

## Summary

We updated architecture and guide documentation to clearly deprecate arm *domains* as a primary specialization mechanism and to center behavior around **task classifications**, task history, and configuration templates. We also marked several aspirational algorithms and distributed features as **design** rather than fully implemented.

## Changes

### Architecture Docs

- `docs/architecture/phases.md`
  - Renamed Phase 2 body from **"Arm Specialization"** to **"Task Classification & Context"**.
  - Rewrote Phase 2 tasks to focus on:
    - Defining task classification keys and TaskConfigurationTemplates.
    - Context budgets and ownership claims.
    - Email-to-documentation workflow creating tasks classified as `documentation` instead of `domain="docs"`.
  - Updated deliverables and success metrics to explicitly mention **task classifications**.

- `docs/architecture/components.md`
  - Misbehavior detection now frames scope as **task scope/claims**, not domains (e.g. "Touching files outside task scope/claims").
  - Marked **Loop Detection & Backoff Throttling** and **Token Budget Protection** sections as **design**, not guaranteed complete implementation.
  - Marked **Arm Domain Definition** as **legacy**, with a note that the current design uses general-purpose arms guided by task classifications and history.
  - Updated Garden category axis to be **file type/category** rather than "file type/domain".

- `docs/architecture/data.md`
  - Updated example ORM schemas and SQL to treat `arms.domain` as **legacy/optional**, with comments that newer code should rely on task classifications and history instead.
  - Replaced domain-based query examples (e.g. `where domain = "ui"`) with guidance to filter on recent activity or classifications.

- `docs/architecture/distributed.md`
  - Annotated `domainAffinity` in `ArmPlacement` as a **legacy** field, with guidance that future placement should be driven by task classifications or capability tags.

### Guides

- `docs/guides/cli.md`
  - Marked `--domain` as a **legacy focus hint**; clarified that newer flows rely on **task classifications** rather than fixed domains.
  - Marked the "Domain Types" table as **Legacy Domain Types**, explaining that arms are general-purpose and that domains are optional hints.
  - Labeled preset configurations as **legacy team shapes**, to reduce the impression of permanent specialist arm identities.

- `docs/guides/getting-started.md`
  - Clarified that arm configuration uses domains only historically; current behavior is driven by **task classifications, history, and availability**.
  - Renamed **"Full-Stack Arms (Default)"** to **"General-Purpose Arms (Default)"**, removing `--domain` from the default spawn example.
  - Reframed **Split-Stack Configuration** as a **legacy style** using optional focus hints.
  - Updated task assignment priorities to use **task classification match** instead of domain match.
  - Updated documentation and file-watching sections to:
    - Notify arms based on **claims, recent work, and task classifications** instead of generic "related domain arms".
    - Replace docs-arm/domain=docs language with **documentation-classified tasks** that any general-purpose arm can take.
    - Change email-to-docs workflow to create tasks classified as `documentation` and remove the requirement for "docs-domain" arms.

## Intent

- Make it clear that:
  - Arms are **general-purpose**; any arm may work on architect, development, QA, or documentation tasks over time.
  - **Task classifications + TaskConfigurationTemplates + history** are the primary levers for behavior.
  - `domain` remains as a **legacy/optional hint** rather than the central routing mechanism.
- Ensure algorithmic and distributed sections are labeled as **design**, so they are not mistaken for fully implemented behavior.

## Next

- Continue tightening the alignment in any remaining docs that:
  - Present domains as first-class specializations (especially older diagrams or tables).
  - Describe loop detection, token throttling, or distributed garden placement as fully implemented if they are not.
- Reflect any future schema changes (e.g. explicit `classification` fields) back into `docs/architecture/data.md` and `src/types/index.ts`.
