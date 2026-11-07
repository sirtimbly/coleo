# Documentation publishing boundary

Contributor note: this directory is excluded from the public site.

Public documentation describes shipped behavior and supported user workflows.
Research, branch reviews, fixture demonstrations, roadmap decisions, and draft
guides remain repository material until verified and edited for users.

`docs/.vitepress/config.ts` owns the `srcExclude` list. It excludes maintenance,
research, workbench reviews, diagrams source notes, historical usage notes,
theme implementation notes, and selected historical architecture proposals.
Exclusion removes pages from the build and generated sitemap; removing sidebar
entries alone does not. Retained public architecture pages should describe the
current implementation rather than a future design as an existing feature.

Everything in `docs/public/` is copied into the deployed site. Do not put internal
HTML reports there. Fixture reports live in `docs/research/`; the workbench demo
generator writes there and can serve its report independently.

Before publishing:

1. Run `bun run docs:build`; dead-link checking must remain enabled.
2. Check `docs/.vitepress/dist/` and `sitemap.xml` for excluded paths and reports.
3. Check changed anchors and public links to assets as well as page links.
4. Verify behavior claims against the relevant implementation. Distinguish a
   permission decision from execution prevention, and coordination from isolation.
5. Move proposed guides into public navigation only when their commands ship and
   their walkthrough has passed against release artifacts.

The setup proposal and its companion guide are retained here as drafts:
[implementation plan](./setup-wizard-plan.md) and [guide draft](./setup-wizard-guide-draft.md).
