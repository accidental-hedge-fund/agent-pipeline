## Why

`CHANGELOG.md` is generator-owned and derived from git tags (`scripts/generate-docs.mjs` / `docs-generate.ts`). The release path creates the annotated `vX.Y.Z` tag after the release merge (auto-tag on default-branch push) but never regenerates or commits `CHANGELOG.md`. The release tree therefore ships without a `## [X.Y.Z]` entry. Once the tag exists, `docs:check` fails on the next PR — as seen on the v1.35.0 train when #910 (PR #965) exhausted recovery budget on stale generated CHANGELOG and blocked the train.

## What Changes

- After a version tag for a release is created (or is known to the release finalization path), the release process SHALL regenerate docs via the existing generator (`node scripts/generate-docs.mjs` / equivalent injectable write path) and commit the resulting generator-owned artifacts, at minimum `CHANGELOG.md`, so the new version section is present on the default branch.
- A clean full-history+tags checkout of the post-regen head SHALL pass `node scripts/generate-docs.mjs --check` (no docs drift attributable to the new tag).
- The next non-release PR SHALL NOT fail `docs:check` solely because the just-shipped tag is missing from committed `CHANGELOG.md`.
- Unit/regression coverage SHALL inject a fake post-tag release list (or equivalent deps seam) and prove the release path regenerates and commits docs — without real network, git, or subprocess as the sole pass path.
- Operator-facing release docs/runbooks SHALL note that tag-derived CHANGELOG regeneration is part of release completion, not a manual follow-up on the next train.

### Acceptance criteria

- [ ] Completing a release for version `X.Y.Z` that creates annotated tag `vX.Y.Z` leaves the default branch with a commit whose tree includes a regenerated `CHANGELOG.md` containing a `## [X.Y.Z]` (or equivalent generator heading) section for that version.
- [ ] A clean checkout of that post-regen commit with full history and tags available passes `node scripts/generate-docs.mjs --check` with exit 0 (no stale generated docs).
- [ ] Opening a subsequent PR against the post-regen default-branch head does not fail the docs freshness gate solely because `CHANGELOG.md` lacks the just-shipped version entry.
- [ ] A unit/regression test with an injected fake tag/release list (deps seam) fails if the release post-tag path does not regenerate and commit generator-owned docs, and passes when that path is present.
- [ ] Release prepare remains prepare-only: it still does not merge, tag, or publish; this change does not move tag or publish authority into `pipeline release` prepare.

## Capabilities

### New Capabilities

- _(none)_

### Modified Capabilities

- `generated-changelog`: Require that shipping a version tag is paired with a committed generator refresh of `CHANGELOG.md` so tag-derived history and the docs freshness gate stay aligned after release.
- `release-auto-tag-on-merge`: Extend the post-merge auto-tag path so that, after a successful annotated version tag is created, generator-owned docs (at least `CHANGELOG.md`) are regenerated and committed when they would otherwise be stale relative to the new tag.
- `release-sub-command`: Clarify release completion obligations around tag-derived CHANGELOG freshness (finish / post-tag surface) without granting prepare-time merge/tag/publish authority.

## Impact

- **Release finalization / auto-tag surface:** `.github/workflows/auto-tag-release.yml` and/or `core/scripts/stages/release-finish.ts` (and any shared helper extracted under `core/scripts/`) gain a post-tag docs regenerate + commit step.
- **Docs generator:** Reuse existing `scripts/generate-docs.mjs` / `core/scripts/docs-generate.ts` write path; no new changelog format.
- **CI / next PRs:** Removes the systemic `docs:check` failure mode that appears on the first post-release PR when CHANGELOG was not refreshed for the new tag.
- **Tests:** New regression(s) with injectable deps for post-tag regenerate+commit; no live network/git/subprocess as sole pass path.
- **Out of scope:** Changing CHANGELOG format; reintroducing ROADMAP "Shipped" prose; moving tag creation into prepare; auto-merge; altering FRG/auto-tag detection rules beyond what is required to run post-tag docs regen after a successful tag.
