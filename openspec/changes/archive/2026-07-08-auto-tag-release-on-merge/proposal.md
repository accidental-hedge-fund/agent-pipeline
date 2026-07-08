# Auto-tag releases when a release PR merges

## Why

Publishing a GitHub Release currently requires a human to push an annotated
`vX.Y.Z` tag *after* merging the release PR. That trailing manual step has failed
three times in one week:

- 2026-07-07: `v1.14.0` was pushed as a **lightweight** tag → `release.yml` failed
  in 12s on its annotated-tag guard (#289); required tag deletion + annotated re-push.
- 2026-07-07: `v1.14.1` published only after a manual annotated tag push in the same
  session.
- 2026-07-08: release PR #410 (`v1.15.0`) merged, but no Release existed until the
  operator noticed (~30 min gap) and pushed the tag manually.

The tag push is mechanical, forgettable, and easy to get wrong (lightweight vs.
annotated). The release pipeline should complete itself: merging the release PR
should be the last human action.

## What Changes

- **Add** a GitHub Actions workflow that triggers on push to the default branch,
  detects a release merge commit, and creates + pushes an **annotated** `vX.Y.Z`
  tag pointing at that commit. Detection requires BOTH signals: the commit subject
  matches the `release: X.Y.Z — …` format produced by `pipeline release`, AND
  `core/package.json` at that commit has `version` exactly equal to `X.Y.Z`.
- The pushed annotated tag then triggers the **existing** `release.yml` unchanged;
  no second publish path is introduced. The tag message carries usable release notes
  (the release PR body / merge-commit body) so `release.yml`'s notes extraction and
  its non-empty-annotation guard still pass.
- **Idempotent & safe**: if `vX.Y.Z` already exists (a manual push raced the
  automation), the workflow is a no-op success — it never force-retags.
- **Update** the `pipeline release` PR body so merging is described as the final
  step; the manual `git tag … && git push` command remains documented only as a
  fallback.
- **Add** a drift-guard test asserting the workflow's merge-commit detection pattern
  matches the actual PR-title / squash-commit-subject format that `pipeline release`
  produces (`release: X.Y.Z — <theme>` / `release: X.Y.Z — <theme> (#N)`).

## Acceptance Criteria

- [ ] A workflow triggered on push to the default branch detects a release merge
      commit (subject matching `release: X.Y.Z — …` AND `core/package.json` version
      equal to `X.Y.Z`) and creates + pushes an annotated tag `vX.Y.Z` at that commit.
- [ ] The annotated tag's message carries usable release notes (release PR body or
      merge-commit body), so `release.yml`'s tag-message extraction yields a non-empty
      Release body.
- [ ] The existing `release.yml` flow (annotated-tag guard included) runs unchanged
      off the pushed tag; no second publish path is added.
- [ ] Idempotent and safe: if `vX.Y.Z` already exists, the workflow is a no-op
      success and never force-retags.
- [ ] Non-release pushes to the default branch are untouched: a doc-only, feature,
      or fix merge never tags. A commit whose subject looks like a release but whose
      `core/package.json` version does not match `X.Y.Z` does not tag.
- [ ] `pipeline release` PR-body instructions updated: merging is the final step; the
      manual tag command is documented only as a fallback.
- [ ] A drift-guard test asserts the detection pattern matches the real `pipeline
      release` PR-title / squash-commit-subject format and rejects a non-release subject.

## Impact

- **New workflow**: `.github/workflows/auto-tag-release.yml` (default-branch push trigger,
  `contents: write` to push the tag).
- **Modified capability**: `release-sub-command` — PR-body instruction requirement.
- **New capability**: `release-auto-tag-on-merge`.
- **Changed code**: `core/scripts/stages/release.ts` (`buildPRBody`) and a new test in
  `core/test/`. Detection pattern single-sourced/drift-guarded against the release
  title format.
- **Out of scope**: `release.yml`'s publish logic and its annotated-tag guard (#289);
  auto-merging release PRs (the human merge stays); changelog generation.
