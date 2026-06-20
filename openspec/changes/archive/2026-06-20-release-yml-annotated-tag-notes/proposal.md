## Why

`release.yml` publishes GitHub Releases using `--notes-from-tag`, but the published body consistently reflects the commit message rather than the annotated tag's curated message — a silent mismatch that forces a manual `gh release edit` after every release. The hand-curated-notes contract has never held in practice.

## What Changes

- Replace `--notes-from-tag` with an explicit approach: read the tag annotation via `git tag -l "$GITHUB_REF_NAME" --format='%(contents)'` and pass the result via `--notes-file`, bypassing `gh`'s tag-annotation resolution entirely.
- Add an explicit lightweight-tag guard: if the tag object type is not `tag` (i.e. the tag is lightweight), the job SHALL fail fast with a clear error before attempting to publish — preventing silent notes-behavior changes.
- Update the workflow comment to accurately describe the new implementation.

## Capabilities

### New Capabilities

- `release-workflow-annotated-notes`: The GitHub Actions `release.yml` workflow SHALL publish a Release whose body equals the pushed annotated tag's message, and SHALL reject lightweight tags before publishing.

### Modified Capabilities

- `release-sub-command`: The `release` sub-command spec documents that pushing a `vX.Y.Z` tag triggers the automated GitHub Release (the workflow's domain). No requirement text changes — the workflow's behavior is clarified, not the CLI sub-command's.

## Impact

- `.github/workflows/release.yml` — shell steps change; no new Actions dependencies.
- `openspec/specs/release-sub-command/spec.md` — a cross-reference note may be added (no requirement delta).
- No application code, tests, or `package.json` changes.
