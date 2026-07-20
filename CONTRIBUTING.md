## Contributor License Agreement

By contributing to this project, you agree that your contributions will be 
licensed under the Business Source License 1.1 (BSL 1.1). 

Additionally, you grant the project maintainers the right to relicense your 
contributions under the Change License (Apache 2.0) on the Change Date.

You must sign the [CLA - Contributor License Agreement] before we can merge 
your PR.

## Commit And Pull Request Titles

Coleo uses [Conventional Commits](https://www.conventionalcommits.org/) to automate versions and release notes.
Format commit messages and pull request titles as `<type>(optional-scope): <description>`.

Examples:

```text
feat(cli): add arm health command
fix(web): prevent websocket reconnect leaks
docs: explain distributed setup
```

Use `feat` for new behavior, `fix` for bug fixes, and `docs`, `refactor`, `test`, `build`, `ci`, `perf`,
`style`, `chore`, or `revert` for other changes. Add `!` and a `BREAKING CHANGE:` footer for breaking changes.

## Releases

Release Please opens release pull requests from commits merged to `master`. Merging a release pull request creates a
GitHub Release, and the `publish-npm.yml` workflow builds and publishes that exact tag to npm with provenance.

Maintainers must configure the `coleo` package on npm with a GitHub Actions trusted publisher for
`sirtimbly/coleo`, using workflow filename `publish-npm.yml` and environment `npm`.
